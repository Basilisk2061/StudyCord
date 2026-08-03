import sys
import unittest
import uuid
from pathlib import Path

from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main


MIGRATION_PATH = (
    BACKEND_DIR
    / "migrations"
    / "20260730_phase19_2_channel_message_pinning.sql"
)


class FakePinClient:
    def __init__(self, *, server_id, channel_id, message_id, role="member", pins=None):
        self.server_id = server_id
        self.channel_id = channel_id
        self.message_id = message_id
        self.role = role
        self.pins = pins or []
        self.events = []

    async def rest(self, method, path, *, params=None, json_body=None, prefer=None):
        self.events.append(("rest", method, path))
        if path == "messages":
            return [{
                "id": self.message_id,
                "server_id": self.server_id,
                "channel_id": self.channel_id,
            }]
        if path == "channels":
            return [{"id": self.channel_id, "server_id": self.server_id}]
        if path == "server_members":
            return [] if self.role is None else [{"role": self.role}]
        raise AssertionError(f"Unexpected REST path: {path}")

    async def rpc(self, function_name, payload):
        self.events.append(("rpc", function_name, payload))
        if function_name == "pin_channel_message":
            return {"message_id": self.message_id}
        if function_name == "unpin_channel_message":
            return True
        if function_name == "get_channel_pinned_messages":
            return self.pins
        raise AssertionError(f"Unexpected RPC: {function_name}")


class Phase19PinningTests(unittest.TestCase):
    def setUp(self):
        self.user_id = str(uuid.uuid4())
        self.server_id = str(uuid.uuid4())
        self.channel_id = str(uuid.uuid4())
        self.message_id = str(uuid.uuid4())

    def tearDown(self):
        main.app.dependency_overrides.clear()

    def authenticate_with(self, client):
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": self.user_id,
            "email": None,
            "supabase_user": client,
        }

    def client(self, **kwargs):
        return FakePinClient(
            server_id=self.server_id,
            channel_id=self.channel_id,
            message_id=self.message_id,
            **kwargs,
        )

    def pin_row(self, **overrides):
        row = {
            "message_id": self.message_id,
            "server_id": self.server_id,
            "channel_id": self.channel_id,
            "content": "Remember this",
            "message_created_at": "2026-07-30T10:00:00Z",
            "author_username": "Author",
            "author_avatar_url": None,
            "pinned_at": "2026-07-30T11:00:00Z",
            "pinned_by_username": "Admin",
            "attachment_id": None,
        }
        row.update(overrides)
        return row

    def test_endpoints_require_authentication_and_valid_uuids(self):
        with TestClient(main.app) as api:
            self.assertEqual(api.post(f"/api/messages/{self.message_id}/pin").status_code, 401)
            self.assertEqual(api.delete(f"/api/messages/{self.message_id}/pin").status_code, 401)
            self.assertEqual(api.get(f"/api/channels/{self.channel_id}/pins").status_code, 401)

        caller = self.client(role="owner")
        self.authenticate_with(caller)
        with TestClient(main.app) as api:
            self.assertEqual(api.post("/api/messages/not-a-uuid/pin").status_code, 422)
            self.assertEqual(api.get("/api/channels/not-a-uuid/pins").status_code, 422)
        self.assertEqual(caller.events, [])

    def test_owner_and_admin_can_pin_and_unpin_any_message(self):
        for role in ("owner", "admin"):
            with self.subTest(role=role):
                caller = self.client(role=role)
                self.authenticate_with(caller)
                with TestClient(main.app) as api:
                    pinned = api.post(f"/api/messages/{self.message_id}/pin")
                    unpinned = api.delete(f"/api/messages/{self.message_id}/pin")
                self.assertEqual(pinned.status_code, 200)
                self.assertTrue(pinned.json()["pinned"])
                self.assertEqual(unpinned.status_code, 200)
                self.assertFalse(unpinned.json()["pinned"])
                self.assertIn(
                    ("rpc", "pin_channel_message", {"p_message_id": self.message_id}),
                    caller.events,
                )

    def test_member_and_former_member_cannot_mutate_pins(self):
        for role in ("member", None):
            with self.subTest(role=role):
                caller = self.client(role=role)
                self.authenticate_with(caller)
                with TestClient(main.app) as api:
                    response = api.post(f"/api/messages/{self.message_id}/pin")
                self.assertEqual(response.status_code, 403)
                self.assertFalse(any(event[0] == "rpc" for event in caller.events))

    def test_current_members_can_view_and_nonmembers_cannot(self):
        for role in ("owner", "admin", "member"):
            with self.subTest(role=role):
                caller = self.client(role=role, pins=[self.pin_row()])
                self.authenticate_with(caller)
                with TestClient(main.app) as api:
                    response = api.get(f"/api/channels/{self.channel_id}/pins")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()[0]["message_id"], self.message_id)

        caller = self.client(role=None, pins=[self.pin_row()])
        self.authenticate_with(caller)
        with TestClient(main.app) as api:
            response = api.get(f"/api/channels/{self.channel_id}/pins")
        self.assertEqual(response.status_code, 403)
        self.assertFalse(any(event[0] == "rpc" for event in caller.events))

    def test_response_is_channel_scoped_and_exposes_only_safe_attachment_fields(self):
        attachment_id = str(uuid.uuid4())
        resource_id = str(uuid.uuid4())
        caller = self.client(pins=[self.pin_row(
            attachment_id=attachment_id,
            attachment_file_name="notes.pdf",
            attachment_file_url="https://example.invalid/file",
            attachment_file_type="application/pdf",
            attachment_file_size=42,
            attachment_resource_id=resource_id,
            storage_path="must-not-leak",
            embedding=[1, 2, 3],
        )])
        self.authenticate_with(caller)
        with TestClient(main.app) as api:
            response = api.get(f"/api/channels/{self.channel_id}/pins")
        self.assertEqual(response.status_code, 200)
        payload = response.json()[0]
        self.assertEqual(payload["attachment"]["id"], attachment_id)
        self.assertNotIn("storage_path", str(payload))
        self.assertNotIn("embedding", str(payload))

        caller.pins = [self.pin_row(channel_id=str(uuid.uuid4()))]
        with TestClient(main.app) as api:
            response = api.get(f"/api/channels/{self.channel_id}/pins")
        self.assertEqual(response.status_code, 500)

    def test_migration_enforces_scope_authorization_cascade_and_realtime(self):
        sql = MIGRATION_PATH.read_text(encoding="utf-8").lower()
        self.assertIn("message_id uuid primary key", sql)
        self.assertIn("foreign key (message_id, server_id, channel_id)", sql)
        self.assertIn("references public.messages(id, server_id, channel_id)", sql)
        self.assertIn("foreign key (channel_id, server_id)", sql)
        self.assertIn("on delete cascade", sql)
        self.assertIn("pinned_by uuid", sql)
        self.assertIn("on delete set null", sql)
        self.assertIn("public.is_server_member(server_id, auth.uid())", sql)
        self.assertIn("public.can_manage_server(v_message.server_id, v_actor_id)", sql)
        self.assertIn("revoke all on table public.pinned_messages from anon, authenticated", sql)
        self.assertIn("on conflict (message_id) do nothing", sql)
        self.assertIn("alter publication supabase_realtime add table public.pinned_messages", sql)
        self.assertNotIn("service_role", sql)
        self.assertNotIn("storage.objects", sql)
        self.assertNotIn("resource_chunks", sql)


if __name__ == "__main__":
    unittest.main()
