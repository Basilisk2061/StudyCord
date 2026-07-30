import asyncio
import hashlib
import inspect
import sys
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from rag2.automatic_ingestion import (
    Rag2AutomaticIngestionError,
    register_attachment_for_rag2,
)
from rag2.indexing import (
    AuthorizedResource,
    IndexingResult,
    Rag2IndexingError,
    index_authorized_resource,
)


FOUNDATION_MIGRATION = (
    BACKEND_DIR
    / "migrations"
    / "20260730_phase18_1b_rag2_resource_foundation.sql"
)
PRIOR_MIGRATION_HASHES = {
    "20260730_phase18_1b_rag2_resource_foundation.sql":
        "7ABB79CD22321E791F24D3D82EEB9527099C9D4F095B445003799DE11B4FD206",
    "20260730_phase18_2_rag2_resource_indexing.sql":
        "2ABA3099825DCC223A6EF17FB012549E6CFC98EDD40EA61921E4EAB35F67CCC9",
    "20260730_phase18_3_rag2_hnsw_retrieval.sql":
        "78D37F7F94D4A4C720A72AFE8C0B7B156E7A213F4A73D1077A7AABF731CDEEEB",
    "20260730_phase18_4_rag2_resource_ranking_ratings.sql":
        "A63B13FD6EF3E401D00704EC0AC8FC3A5B1B92388C401203205852D6BC5F9A57",
}


def make_resource(user_id, **overrides):
    row = {
        "id": str(uuid.uuid4()),
        "server_id": str(uuid.uuid4()),
        "uploader_id": user_id,
        "original_filename": "new-notes.pdf",
        "storage_bucket": "channel-files",
        "storage_path": "server/channel/user/new-notes.pdf",
        "visibility": "server",
        "index_status": "unindexed",
        "index_started_at": None,
    }
    row.update(overrides)
    return row


class FakeCallerClient:
    def __init__(self, row, *, role="member", rpc_error=None):
        self.row = row
        self.role = role
        self.rpc_error = rpc_error
        self.calls = []

    async def rpc(self, function_name, payload):
        self.calls.append(("rpc", function_name, payload))
        if self.rpc_error:
            raise self.rpc_error
        return self.row["id"]

    async def rest(
        self,
        method,
        path,
        *,
        params=None,
        json_body=None,
        prefer=None,
    ):
        self.calls.append(("rest", path, params))
        if path == "server_resources":
            return [self.row]
        if path == "server_members":
            return [{"role": self.role}] if self.role else []
        raise AssertionError(path)


class Rag2AutomaticRegistrationTests(unittest.TestCase):
    def test_registration_reuses_the_attachment_rpc_with_no_storage_metadata(self):
        user_id = str(uuid.uuid4())
        row = make_resource(user_id)
        client = FakeCallerClient(row)
        attachment_id = str(uuid.uuid4())

        first = asyncio.run(
            register_attachment_for_rag2(client, attachment_id)
        )
        second = asyncio.run(
            register_attachment_for_rag2(client, attachment_id)
        )

        self.assertEqual(first, row["id"])
        self.assertEqual(second, row["id"])
        for _, function_name, payload in client.calls:
            self.assertEqual(
                function_name,
                "register_server_resource_from_attachment",
            )
            self.assertEqual(
                payload,
                {
                    "p_attachment_id": attachment_id,
                    "p_title": None,
                },
            )
            self.assertNotIn("storage_path", payload)
            self.assertNotIn("storage_bucket", payload)

    def test_registration_failures_are_safe(self):
        row = make_resource(str(uuid.uuid4()))
        client = FakeCallerClient(
            row,
            rpc_error=HTTPException(403, "database detail"),
        )
        with self.assertRaises(Rag2AutomaticIngestionError) as denied:
            asyncio.run(
                register_attachment_for_rag2(
                    client,
                    str(uuid.uuid4()),
                )
            )
        self.assertEqual(denied.exception.status_code, 403)
        self.assertNotIn("database detail", denied.exception.detail)

    def test_existing_rpc_is_candidate_only_and_idempotent(self):
        sql = FOUNDATION_MIGRATION.read_text(encoding="utf-8").lower()
        self.assertIn(r"\.(pdf|docx|txt)$", sql)
        self.assertIn("if v_attachment.resource_id is not null", sql)
        self.assertIn("return v_attachment.resource_id", sql)
        self.assertIn(
            "on conflict (storage_bucket, storage_path) do nothing",
            sql,
        )
        self.assertIn("detected_type", sql)
        self.assertIn("'unindexed'", sql)


class Rag2AutomaticIngestionEndpointTests(unittest.TestCase):
    def setUp(self):
        self.user_id = str(uuid.uuid4())
        self.attachment_id = str(uuid.uuid4())
        self.row = make_resource(self.user_id)

    def tearDown(self):
        main.app.dependency_overrides.clear()

    def authenticate(self, caller):
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": self.user_id,
            "email": None,
            "supabase_user": caller,
        }

    def successful_result(self):
        return IndexingResult(
            resource_id=self.row["id"],
            server_id=self.row["server_id"],
            detected_type="pdf",
            chunk_count=2,
            indexed_at=datetime(2026, 7, 30, tzinfo=timezone.utc),
        )

    def test_authentication_and_attachment_uuid_are_required(self):
        with TestClient(main.app) as api:
            unauthenticated = api.post(
                f"/api/rag2/attachments/{self.attachment_id}/ingest"
            )
        self.assertEqual(unauthenticated.status_code, 401)

        self.authenticate(FakeCallerClient(self.row))
        with TestClient(main.app) as api:
            invalid = api.post(
                "/api/rag2/attachments/not-a-uuid/ingest"
            )
        self.assertEqual(invalid.status_code, 422)

    def test_registration_schedules_the_existing_indexer(self):
        caller = FakeCallerClient(self.row)
        self.authenticate(caller)
        trusted = object()
        with (
            patch("main.supabase_admin", return_value=trusted) as admin,
            patch(
                "main.index_authorized_resource",
                new=AsyncMock(return_value=self.successful_result()),
            ) as indexer,
            TestClient(main.app) as api,
        ):
            response = api.post(
                f"/api/rag2/attachments/{self.attachment_id}/ingest"
            )

        self.assertEqual(response.status_code, 202, response.text)
        self.assertTrue(response.json()["indexing_scheduled"])
        self.assertEqual(response.json()["resource_id"], self.row["id"])
        self.assertEqual(caller.calls[0][0:2], (
            "rpc",
            "register_server_resource_from_attachment",
        ))
        admin.assert_called_once()
        indexer.assert_awaited_once()

    def test_existing_ready_and_active_processing_are_idempotent(self):
        cases = (
            {"index_status": "ready"},
            {
                "index_status": "processing",
                "index_started_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        for overrides in cases:
            with self.subTest(overrides=overrides):
                self.row = make_resource(self.user_id, **overrides)
                caller = FakeCallerClient(self.row)
                self.authenticate(caller)
                with (
                    patch("main.supabase_admin") as admin,
                    patch(
                        "main.index_authorized_resource",
                        new=AsyncMock(),
                    ) as indexer,
                    TestClient(main.app) as api,
                ):
                    response = api.post(
                        f"/api/rag2/attachments/{self.attachment_id}/ingest"
                    )
                self.assertEqual(response.status_code, 202, response.text)
                self.assertFalse(response.json()["indexing_scheduled"])
                admin.assert_not_called()
                indexer.assert_not_awaited()

    def test_nonmember_and_registration_failure_never_reach_service_role(self):
        cases = (
            FakeCallerClient(self.row, role=None),
            FakeCallerClient(
                self.row,
                rpc_error=HTTPException(500, "database failure"),
            ),
        )
        for caller in cases:
            with self.subTest(role=caller.role):
                self.authenticate(caller)
                with (
                    patch("main.supabase_admin") as admin,
                    TestClient(main.app) as api,
                ):
                    response = api.post(
                        f"/api/rag2/attachments/{self.attachment_id}/ingest"
                    )
                self.assertIn(response.status_code, {403, 500})
                admin.assert_not_called()

    def test_corrupt_or_provider_failure_is_swallowed_by_background_boundary(self):
        for status in (422, 502, 500):
            with self.subTest(status=status):
                with (
                    patch("main.supabase_admin", return_value=object()),
                    patch(
                        "main.index_authorized_resource",
                        new=AsyncMock(
                            side_effect=Rag2IndexingError(
                                status,
                                "semantic failure",
                            )
                        ),
                    ),
                ):
                    asyncio.run(
                        main._run_automatic_rag2_indexing(
                            AuthorizedResource(**self.row)
                        )
                    )

    def test_endpoint_contains_no_backfill_or_second_indexer(self):
        source = inspect.getsource(main.rag2_automatically_ingest_attachment)
        self.assertIn("register_attachment_for_rag2", source)
        self.assertIn("_run_automatic_rag2_indexing", source)
        self.assertNotIn("storage_path", source)
        self.assertNotIn("storage_bucket", source)
        self.assertNotIn("message_attachments", source)
        self.assertNotIn("resource_chunks", source)

    def test_prior_migrations_and_ranking_are_unchanged(self):
        migration_dir = BACKEND_DIR / "migrations"
        for filename, expected in PRIOR_MIGRATION_HASHES.items():
            digest = hashlib.sha256(
                (migration_dir / filename).read_bytes()
            ).hexdigest().upper()
            self.assertEqual(digest, expected)

    def test_successful_completion_feeds_existing_ready_only_search(self):
        indexing_source = inspect.getsource(index_authorized_resource)
        ranking_sql = (
            BACKEND_DIR
            / "migrations"
            / "20260730_phase18_4_rag2_resource_ranking_ratings.sql"
        ).read_text(encoding="utf-8").lower()
        self.assertIn("complete_rag2_resource_indexing", indexing_source)
        self.assertIn("resource.index_status = 'ready'", ranking_sql)
        self.assertIn("resource.visibility = 'server'", ranking_sql)
        self.assertNotIn("order by average_rating", ranking_sql)
if __name__ == "__main__":
    unittest.main()
