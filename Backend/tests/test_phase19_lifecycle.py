import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from lifecycle import LifecycleTargetError, parse_message_deletion_targets


MIGRATION_PATH = (
    BACKEND_DIR
    / "migrations"
    / "20260730_phase19_1_message_membership_lifecycle.sql"
)


class FakeCallerClient:
    def __init__(
        self,
        *,
        role="member",
        owner_id=None,
        targets=None,
        delete_result=True,
        rpc_error=None,
        events=None,
    ):
        self.role = role
        self.owner_id = owner_id
        self.targets = targets or []
        self.delete_result = delete_result
        self.rpc_error = rpc_error
        self.events = events if events is not None else []

    async def rest(
        self,
        method,
        path,
        *,
        params=None,
        json_body=None,
        prefer=None,
    ):
        self.events.append(("caller_rest", method, path))
        if path == "server_members":
            return [] if self.role is None else [{"role": self.role}]
        if path == "servers":
            return [{"id": params["id"][3:], "owner_id": self.owner_id}]
        raise AssertionError(f"Unexpected path: {path}")

    async def rpc(self, function_name, payload):
        self.events.append(("rpc", function_name, payload))
        if self.rpc_error:
            raise self.rpc_error
        if function_name == "prepare_own_message_deletion":
            return self.targets
        if function_name == "delete_own_message":
            return self.delete_result
        if function_name == "leave_server":
            return True
        raise AssertionError(f"Unexpected RPC: {function_name}")


class FakeAdminClient:
    def __init__(self, *, storage_error=None, voice_error=None, events=None):
        self.storage_error = storage_error
        self.voice_error = voice_error
        self.events = events if events is not None else []

    async def storage_remove(self, bucket, paths):
        self.events.append(("storage_remove", bucket, paths))
        if self.storage_error:
            raise self.storage_error
        return []

    async def rest(
        self,
        method,
        path,
        *,
        params=None,
        json_body=None,
        prefer=None,
    ):
        self.events.append(("admin_rest", method, path, params))
        if self.voice_error:
            raise self.voice_error
        return None


class Phase19LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.user_id = str(uuid.uuid4())
        self.server_id = str(uuid.uuid4())
        self.channel_id = str(uuid.uuid4())
        self.message_id = str(uuid.uuid4())
        self.path = (
            f"{self.server_id}/{self.channel_id}/{self.user_id}/"
            "1720000000000-notes.pdf"
        )

    def tearDown(self):
        main.app.dependency_overrides.clear()

    def authenticate_with(self, caller):
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": self.user_id,
            "email": None,
            "supabase_user": caller,
        }

    def target(self, path=None):
        return {
            "storage_path": path or self.path,
            "server_id": self.server_id,
            "channel_id": self.channel_id,
            "user_id": self.user_id,
        }

    def test_target_parser_accepts_only_caller_scoped_canonical_paths(self):
        parsed = parse_message_deletion_targets(
            [self.target(), self.target()],
            expected_user_id=self.user_id,
        )
        self.assertEqual([target.storage_path for target in parsed], [self.path])

        unsafe_paths = (
            f"{self.server_id}/{self.channel_id}/{self.user_id}/../secret",
            f"{self.server_id}/{self.channel_id}/{self.user_id}/folder\\secret",
            f"{self.server_id}//{self.user_id}/secret",
            "other/path",
        )
        for unsafe_path in unsafe_paths:
            with self.subTest(path=unsafe_path):
                with self.assertRaises(LifecycleTargetError):
                    parse_message_deletion_targets(
                        [self.target(unsafe_path)],
                        expected_user_id=self.user_id,
                    )

    def test_message_delete_requires_authentication(self):
        with TestClient(main.app) as api:
            response = api.delete(f"/api/messages/{self.message_id}")
        self.assertEqual(response.status_code, 401)

    def test_invalid_message_uuid_is_rejected(self):
        caller = FakeCallerClient()
        self.authenticate_with(caller)
        with TestClient(main.app) as api:
            response = api.delete("/api/messages/not-a-uuid")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(caller.events, [])

    def test_message_delete_removes_storage_before_atomic_database_rpc(self):
        events = []
        caller = FakeCallerClient(targets=[self.target()], events=events)
        admin = FakeAdminClient(events=events)
        self.authenticate_with(caller)

        with patch.object(main, "supabase_admin", return_value=admin):
            with TestClient(main.app) as api:
                response = api.delete(f"/api/messages/{self.message_id}")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["deleted"])
        self.assertEqual(
            events,
            [
                (
                    "rpc",
                    "prepare_own_message_deletion",
                    {"p_message_id": self.message_id},
                ),
                ("storage_remove", "channel-files", [self.path]),
                (
                    "rpc",
                    "delete_own_message",
                    {"p_message_id": self.message_id},
                ),
            ],
        )

    def test_storage_failure_keeps_database_delete_unattempted(self):
        events = []
        caller = FakeCallerClient(targets=[self.target()], events=events)
        admin = FakeAdminClient(
            storage_error=RuntimeError("storage unavailable"),
            events=events,
        )
        self.authenticate_with(caller)

        with patch.object(main, "supabase_admin", return_value=admin):
            with TestClient(main.app) as api:
                response = api.delete(f"/api/messages/{self.message_id}")

        self.assertEqual(response.status_code, 502)
        self.assertNotIn("delete_own_message", str(events))
        self.assertIn("message was not deleted", response.json()["detail"].lower())

    def test_text_only_and_idempotent_delete_need_no_service_role(self):
        caller = FakeCallerClient(targets=[], delete_result=False)
        self.authenticate_with(caller)

        with patch.object(
            main,
            "supabase_admin",
            side_effect=AssertionError("admin client must not be created"),
        ):
            with TestClient(main.app) as api:
                response = api.delete(f"/api/messages/{self.message_id}")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["deleted"])

    def test_non_author_delete_is_rejected_before_storage(self):
        caller = FakeCallerClient(
            rpc_error=HTTPException(
                status_code=403,
                detail="Only the message author may delete this message.",
            )
        )
        self.authenticate_with(caller)

        with patch.object(
            main,
            "supabase_admin",
            side_effect=AssertionError("storage must not be reached"),
        ):
            with TestClient(main.app) as api:
                response = api.delete(f"/api/messages/{self.message_id}")
        self.assertEqual(response.status_code, 403)

    def test_missing_and_cross_scope_messages_are_safe(self):
        for status_code, detail in (
            (404, "Message not found."),
            (409, "The message cleanup metadata is inconsistent."),
        ):
            with self.subTest(status_code=status_code):
                caller = FakeCallerClient(
                    rpc_error=HTTPException(status_code=status_code, detail=detail)
                )
                self.authenticate_with(caller)
                with patch.object(
                    main,
                    "supabase_admin",
                    side_effect=AssertionError("storage must not be reached"),
                ):
                    with TestClient(main.app) as api:
                        response = api.delete(
                            f"/api/messages/{self.message_id}"
                        )
                self.assertEqual(response.status_code, status_code)

    def test_shared_or_absent_attachment_target_preserves_storage(self):
        caller = FakeCallerClient(targets=[])
        self.authenticate_with(caller)
        with patch.object(
            main,
            "supabase_admin",
            side_effect=AssertionError("shared storage must not be removed"),
        ):
            with TestClient(main.app) as api:
                response = api.delete(f"/api/messages/{self.message_id}")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["deleted"])

    def test_member_leave_cleans_voice_then_removes_only_own_membership(self):
        events = []
        caller = FakeCallerClient(
            role="member",
            owner_id=str(uuid.uuid4()),
            events=events,
        )
        admin = FakeAdminClient(events=events)
        self.authenticate_with(caller)

        with patch.object(main, "supabase_admin", return_value=admin):
            with TestClient(main.app) as api:
                response = api.post(f"/api/servers/{self.server_id}/leave")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [event[0:2] for event in events],
            [
                ("caller_rest", "GET"),
                ("caller_rest", "GET"),
                ("admin_rest", "DELETE"),
                ("rpc", "leave_server"),
            ],
        )

    def test_owner_cannot_leave_and_no_cleanup_occurs(self):
        caller = FakeCallerClient(role="owner", owner_id=self.user_id)
        self.authenticate_with(caller)

        with patch.object(
            main,
            "supabase_admin",
            side_effect=AssertionError("owner denial must precede cleanup"),
        ):
            with TestClient(main.app) as api:
                response = api.post(f"/api/servers/{self.server_id}/leave")

        self.assertEqual(response.status_code, 403)
        self.assertIn("Transfer ownership", response.json()["detail"])

    def test_nonmember_cannot_leave(self):
        caller = FakeCallerClient(role=None)
        self.authenticate_with(caller)
        with patch.object(
            main,
            "supabase_admin",
            side_effect=AssertionError("nonmember denial must precede cleanup"),
        ):
            with TestClient(main.app) as api:
                response = api.post(f"/api/servers/{self.server_id}/leave")
        self.assertEqual(response.status_code, 403)

    def test_voice_cleanup_failure_preserves_membership(self):
        events = []
        caller = FakeCallerClient(
            role="admin",
            owner_id=str(uuid.uuid4()),
            events=events,
        )
        admin = FakeAdminClient(
            voice_error=RuntimeError("voice cleanup unavailable"),
            events=events,
        )
        self.authenticate_with(caller)

        with patch.object(main, "supabase_admin", return_value=admin):
            with TestClient(main.app) as api:
                response = api.post(f"/api/servers/{self.server_id}/leave")

        self.assertEqual(response.status_code, 502)
        self.assertNotIn("leave_server", str(events))

    def test_migration_enforces_database_authorization_and_cleanup_boundary(self):
        sql = MIGRATION_PATH.read_text(encoding="utf-8")
        self.assertIn("alter table public.messages replica identity full", sql)
        self.assertIn("only the message author may delete this message", sql)
        self.assertIn("public.is_server_member", sql)
        self.assertIn("delete from public.server_resources", sql)
        self.assertIn("other_attachment.message_id <> p_message_id", sql)
        self.assertIn("delete from public.messages", sql)
        self.assertIn("role <> 'owner'", sql)
        self.assertIn("for update", sql.lower())
        self.assertIn("server owner must transfer ownership", sql)
        self.assertIn("security definer", sql.lower())
        self.assertGreaterEqual(sql.lower().count("set search_path = ''"), 3)
        self.assertNotIn("service_role", sql)
        self.assertNotIn("rag_documents", sql)
        self.assertNotIn("resource_chunks", sql)
        self.assertNotIn("resource_ratings", sql)

        leave_function = sql.split(
            "create or replace function public.leave_server", 1
        )[1]
        self.assertIn("delete from public.server_members", leave_function)
        self.assertNotIn("delete from public.messages", leave_function)
        self.assertNotIn("delete from public.message_attachments", leave_function)
        self.assertNotIn("delete from public.server_resources", leave_function)

    def test_existing_fk_and_access_architecture_supplies_required_cascades(self):
        chunks_sql = (
            BACKEND_DIR
            / "migrations"
            / "20260730_phase18_2_rag2_resource_indexing.sql"
        ).read_text(encoding="utf-8")
        ratings_sql = (
            BACKEND_DIR
            / "migrations"
            / "20260730_phase18_4_rag2_resource_ranking_ratings.sql"
        ).read_text(encoding="utf-8")
        main_source = (BACKEND_DIR / "main.py").read_text(encoding="utf-8")

        self.assertRegex(
            chunks_sql,
            r"references public\.server_resources\(id, server_id\)\s+on delete cascade",
        )
        self.assertRegex(
            ratings_sql,
            r"references public\.server_resources\(id, server_id\)\s+on delete cascade",
        )
        self.assertIn("require_server_permission", main_source)
        self.assertIn("handoff_rag2_resource_to_rag1", main_source)
        self.assertNotIn("rag1_resource_imports", MIGRATION_PATH.read_text("utf-8"))


if __name__ == "__main__":
    unittest.main()
