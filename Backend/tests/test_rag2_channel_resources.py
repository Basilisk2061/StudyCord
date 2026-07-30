import asyncio
import hashlib
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from rag2.channel_resources import (
    Rag2ChannelResourceError,
    get_channel_resource_metadata,
)


MIGRATION_PATH = (
    BACKEND_DIR
    / "migrations"
    / "20260730_phase18_5c_channel_resource_metadata.sql"
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


def resource_row(resource_id):
    return {
        "resource_id": resource_id,
        "title": "HNSW",
        "original_filename": "HNSW.docx",
        "detected_type": "docx",
        "size_bytes": 30310,
        "average_rating": 4.5,
        "rating_count": 8,
        "current_user_rating": 5,
    }


class FakeCallerClient:
    def __init__(self, rows=None, role="member", error=None):
        self.rows = rows if rows is not None else []
        self.role = role
        self.error = error
        self.calls = []

    async def rpc(self, function_name, payload):
        self.calls.append(("rpc", function_name, payload))
        if self.error:
            raise self.error
        return self.rows

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
        if path == "server_members":
            return [{"role": self.role}] if self.role else []
        raise AssertionError(path)


class Rag2ChannelResourceMigrationTests(unittest.TestCase):
    def test_migration_is_bounded_authorized_and_safe(self):
        sql = MIGRATION_PATH.read_text(encoding="utf-8").lower()
        self.assertIn("security definer", sql)
        self.assertIn("set search_path = ''", sql)
        self.assertIn("auth.uid()", sql)
        self.assertIn("public.is_server_member(p_server_id, v_actor_id)", sql)
        self.assertIn("cardinality(p_resource_ids) > 200", sql)
        self.assertIn("resource.server_id = p_server_id", sql)
        self.assertIn("resource.visibility = 'server'", sql)
        self.assertIn("resource.index_status = 'ready'", sql)
        self.assertIn("resource.detected_type in ('pdf', 'docx', 'txt')", sql)
        self.assertIn("revoke all", sql)
        self.assertIn("from public, anon", sql)
        self.assertIn("to authenticated", sql)
        for forbidden in (
            "storage_bucket",
            "storage_path",
            "content_sha256",
            "embedding_model",
            "embedding_dimensions",
            "index_attempt_id",
            "uploader_id",
        ):
            self.assertNotIn(forbidden, sql)

    def test_prior_phase_migrations_are_unchanged(self):
        migration_dir = BACKEND_DIR / "migrations"
        for filename, expected in PRIOR_MIGRATION_HASHES.items():
            digest = hashlib.sha256(
                (migration_dir / filename).read_bytes()
            ).hexdigest().upper()
            self.assertEqual(digest, expected, filename)


class Rag2ChannelResourceServiceTests(unittest.TestCase):
    def test_service_uses_one_caller_scoped_batch_rpc(self):
        resource_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        client = FakeCallerClient([resource_row(resource_ids[0])])
        rows = asyncio.run(
            get_channel_resource_metadata(
                client,
                str(uuid.uuid4()),
                resource_ids,
            )
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(client.calls[0][1], "get_channel_resource_card_metadata")
        self.assertEqual(
            client.calls[0][2]["p_resource_ids"],
            resource_ids,
        )
        self.assertFalse(hasattr(rows[0], "storage_path"))

    def test_service_rejects_oversized_and_invalid_database_results(self):
        with self.assertRaises(Rag2ChannelResourceError) as oversized:
            asyncio.run(
                get_channel_resource_metadata(
                    FakeCallerClient(),
                    str(uuid.uuid4()),
                    [str(uuid.uuid4()) for _ in range(201)],
                )
            )
        self.assertEqual(oversized.exception.status_code, 422)

        with self.assertRaises(Rag2ChannelResourceError) as invalid:
            asyncio.run(
                get_channel_resource_metadata(
                    FakeCallerClient([{"resource_id": str(uuid.uuid4())}]),
                    str(uuid.uuid4()),
                    [str(uuid.uuid4())],
                )
            )
        self.assertEqual(invalid.exception.status_code, 500)


class Rag2ChannelResourceEndpointTests(unittest.TestCase):
    def setUp(self):
        self.user_id = str(uuid.uuid4())
        self.server_id = str(uuid.uuid4())
        self.resource_id = str(uuid.uuid4())

    def tearDown(self):
        main.app.dependency_overrides.clear()

    def authenticate(self, client):
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": self.user_id,
            "email": None,
            "supabase_user": client,
        }

    def test_authentication_and_membership_precede_metadata_rpc(self):
        with TestClient(main.app) as api:
            response = api.post(
                f"/api/rag2/servers/{self.server_id}/resources/channel-metadata",
                json={"resource_ids": [self.resource_id]},
            )
        self.assertEqual(response.status_code, 401)

        client = FakeCallerClient(role=None)
        self.authenticate(client)
        with (
            patch("main.get_channel_resource_metadata", new=AsyncMock()) as service,
            TestClient(main.app) as api,
        ):
            denied = api.post(
                f"/api/rag2/servers/{self.server_id}/resources/channel-metadata",
                json={"resource_ids": [self.resource_id]},
            )
        self.assertEqual(denied.status_code, 403)
        service.assert_not_awaited()

    def test_member_uses_caller_context_and_returns_safe_fields(self):
        client = FakeCallerClient(role="member")
        self.authenticate(client)
        expected = resource_row(self.resource_id)
        with (
            patch(
                "main.get_channel_resource_metadata",
                new=AsyncMock(return_value=[expected]),
            ) as service,
            patch("main.supabase_admin") as admin,
            TestClient(main.app) as api,
        ):
            response = api.post(
                f"/api/rag2/servers/{self.server_id}/resources/channel-metadata",
                json={"resource_ids": [self.resource_id]},
            )
        self.assertEqual(response.status_code, 200, response.text)
        service.assert_awaited_once_with(
            client,
            self.server_id,
            [self.resource_id],
        )
        admin.assert_not_called()
        body = response.json()[0]
        self.assertEqual(
            set(body),
            {
                "resource_id",
                "title",
                "original_filename",
                "detected_type",
                "size_bytes",
                "average_rating",
                "rating_count",
                "current_user_rating",
            },
        )


if __name__ == "__main__":
    unittest.main()
