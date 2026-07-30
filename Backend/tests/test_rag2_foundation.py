import sys
import unittest
import uuid
from pathlib import Path

from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from rag2.resources import RESOURCE_LIST_COLUMNS, list_server_resources


MIGRATION_PATH = (
    BACKEND_DIR
    / "migrations"
    / "20260730_phase18_1b_rag2_resource_foundation.sql"
)


class FakeCallerScopedClient:
    def __init__(self, *, role="member", resource_rows=None):
        self.role = role
        self.resource_rows = resource_rows or []
        self.calls = []

    async def rest(
        self,
        method,
        path,
        *,
        params=None,
        json_body=None,
        prefer=None,
    ):
        self.calls.append(
            {
                "method": method,
                "path": path,
                "params": params,
                "json_body": json_body,
                "prefer": prefer,
            }
        )
        if path == "server_members":
            if self.role is None:
                return []
            return [{"role": self.role}]
        if path == "server_resources":
            return self.resource_rows
        raise AssertionError(f"Unexpected PostgREST path: {path}")


class Rag2FoundationTests(unittest.TestCase):
    def setUp(self):
        self.user_id = str(uuid.uuid4())
        self.server_id = str(uuid.uuid4())
        self.resource_id = str(uuid.uuid4())
        self.resource_row = {
            "id": self.resource_id,
            "server_id": self.server_id,
            "title": "Machine Learning Notes",
            "original_filename": "machine-learning.pdf",
            "declared_mime_type": "application/pdf",
            "detected_type": None,
            "size_bytes": 4096,
            "visibility": "server",
            "index_status": "unindexed",
            "created_at": "2026-07-30T00:00:00+00:00",
            "updated_at": "2026-07-30T00:00:00+00:00",
            "storage_bucket": "channel-files",
            "storage_path": "secret/server/path.pdf",
            "file_url": "https://example.invalid/public-object",
            "uploader_id": self.user_id,
        }

    def tearDown(self):
        main.app.dependency_overrides.clear()

    def authenticate_with(self, client):
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": self.user_id,
            "email": None,
            "supabase_user": client,
        }

    def test_resource_service_uses_explicit_safe_projection_and_scope(self):
        caller = FakeCallerScopedClient(resource_rows=[self.resource_row])

        import asyncio

        rows = asyncio.run(
            list_server_resources(
                caller,
                self.server_id,
                limit=25,
                offset=5,
            )
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(str(rows[0].id), self.resource_id)
        self.assertEqual(rows[0].index_status, "unindexed")
        self.assertIsNone(rows[0].detected_type)
        self.assertEqual(
            caller.calls,
            [
                {
                    "method": "GET",
                    "path": "server_resources",
                    "params": {
                        "server_id": f"eq.{self.server_id}",
                        "select": RESOURCE_LIST_COLUMNS,
                        "order": "created_at.desc,id.asc",
                        "limit": "25",
                        "offset": "5",
                    },
                    "json_body": None,
                    "prefer": None,
                }
            ],
        )
        self.assertNotIn("storage_path", RESOURCE_LIST_COLUMNS)
        self.assertNotIn("storage_bucket", RESOURCE_LIST_COLUMNS)
        self.assertNotIn("uploader_id", RESOURCE_LIST_COLUMNS)

    def test_resource_service_rejects_invalid_pagination(self):
        caller = FakeCallerScopedClient()

        import asyncio

        for limit, offset in ((0, 0), (101, 0), (50, -1)):
            with self.subTest(limit=limit, offset=offset):
                with self.assertRaises(ValueError):
                    asyncio.run(
                        list_server_resources(
                            caller,
                            self.server_id,
                            limit=limit,
                            offset=offset,
                        )
                    )
        self.assertEqual(caller.calls, [])

    def test_endpoint_requires_authentication_and_server_membership(self):
        with TestClient(main.app) as api:
            unauthenticated = api.get(
                f"/api/rag2/servers/{self.server_id}/resources"
            )

        nonmember_client = FakeCallerScopedClient(role=None)
        self.authenticate_with(nonmember_client)
        with TestClient(main.app) as api:
            forbidden = api.get(
                f"/api/rag2/servers/{self.server_id}/resources"
            )

        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(
            [call["path"] for call in nonmember_client.calls],
            ["server_members"],
        )

    def test_endpoint_returns_only_safe_rls_scoped_metadata(self):
        caller = FakeCallerScopedClient(resource_rows=[self.resource_row])
        self.authenticate_with(caller)

        with TestClient(main.app) as api:
            response = api.get(
                f"/api/rag2/servers/{self.server_id}/resources",
                params={"limit": 10, "offset": 0},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 1)
        payload = response.json()[0]
        self.assertEqual(
            set(payload),
            {
                "id",
                "server_id",
                "title",
                "original_filename",
                "declared_mime_type",
                "detected_type",
                "size_bytes",
                "visibility",
                "index_status",
                "created_at",
                "updated_at",
            },
        )
        self.assertNotIn("storage_path", response.text)
        self.assertNotIn("channel-files", response.text)
        self.assertNotIn("example.invalid", response.text)
        self.assertEqual(
            [call["path"] for call in caller.calls],
            ["server_members", "server_resources"],
        )

    def test_endpoint_validates_server_uuid_and_pagination(self):
        caller = FakeCallerScopedClient(resource_rows=[])
        self.authenticate_with(caller)

        with TestClient(main.app) as api:
            invalid_server = api.get(
                "/api/rag2/servers/not-a-uuid/resources"
            )
            invalid_limit = api.get(
                f"/api/rag2/servers/{self.server_id}/resources",
                params={"limit": 101},
            )
            invalid_offset = api.get(
                f"/api/rag2/servers/{self.server_id}/resources",
                params={"offset": -1},
            )

        self.assertEqual(invalid_server.status_code, 422)
        self.assertEqual(invalid_limit.status_code, 422)
        self.assertEqual(invalid_offset.status_code, 422)

    def test_migration_preserves_phase_boundaries_and_retention(self):
        sql = MIGRATION_PATH.read_text(encoding="utf-8").lower()

        self.assertIn("create table public.server_resources", sql)
        self.assertIn("on delete restrict", sql)
        self.assertIn("add column resource_id uuid", sql)
        self.assertIn(
            "foreign key (resource_id, server_id)",
            sql,
        )
        self.assertIn("on delete set null (resource_id)", sql)
        self.assertNotIn("create extension", sql)
        self.assertNotIn("create table public.resource_chunks", sql)
        self.assertNotIn("create table public.resource_ratings", sql)
        self.assertNotIn("using hnsw", sql)
        self.assertNotIn("set resource_id = gen_random_uuid", sql)

    def test_migration_registration_is_candidate_only_and_private_is_dormant(self):
        sql = MIGRATION_PATH.read_text(encoding="utf-8").lower()

        self.assertIn(
            "register_server_resource_from_attachment",
            sql,
        )
        self.assertIn("security definer", sql)
        self.assertIn("for update of attachment", sql)
        self.assertIn("attachment.user_id = message.user_id", sql)
        self.assertIn("message.server_id = channel.server_id", sql)
        self.assertIn("detected_type", sql)
        self.assertIn("'unindexed'", sql)
        self.assertIn("'server'", sql)
        self.assertIn(
            "visibility <> 'private'\n      or storage_bucket <> 'channel-files'",
            sql,
        )
        self.assertNotIn("grant insert on table public.server_resources", sql)

    def test_migration_has_member_scoped_rls_and_immutable_column_grants(self):
        sql = MIGRATION_PATH.read_text(encoding="utf-8").lower()

        self.assertIn(
            'create policy "server_resources_select_visible"',
            sql,
        )
        self.assertIn(
            "public.is_server_member(server_id, auth.uid())",
            sql,
        )
        self.assertIn(
            "visibility = 'private'\n      and uploader_id = auth.uid()",
            sql,
        )
        self.assertIn(
            'create policy "server_resources_delete_by_owner_or_manager"',
            sql,
        )
        self.assertIn(
            "public.can_manage_server(server_id, auth.uid())",
            sql,
        )
        self.assertIn(
            "grant update (title) on table public.server_resources",
            sql,
        )
        self.assertNotIn(
            "grant update (server_id",
            sql,
        )
        self.assertNotIn(
            "grant update (uploader_id",
            sql,
        )
        self.assertNotIn(
            "grant update (visibility",
            sql,
        )


if __name__ == "__main__":
    unittest.main()
