import re
import unittest
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
MIGRATION_PATH = (
    BACKEND_DIR
    / "migrations"
    / "20260801_message_moderation_deletion.sql"
)


class MessageModerationMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = MIGRATION_PATH.read_text(encoding="utf-8")
        cls.normalized = re.sub(r"\s+", " ", cls.sql.lower())

    def test_replaces_only_the_two_existing_rpc_functions(self):
        self.assertEqual(
            self.normalized.count("create or replace function"),
            2,
        )
        self.assertIn(
            "create or replace function public.prepare_own_message_deletion",
            self.normalized,
        )
        self.assertIn(
            "create or replace function public.delete_own_message",
            self.normalized,
        )
        for forbidden in (
            "create table",
            "drop table",
            "alter table",
            "create index",
            "drop index",
            "create trigger",
            "drop trigger",
            "create policy",
            "alter policy",
            "drop policy",
        ):
            self.assertNotIn(forbidden, self.normalized)

    def test_author_or_manager_authorization_is_enforced_in_both_rpcs(self):
        authorization = (
            "v_message.user_id is distinct from v_actor_id and not "
            "public.can_manage_server(v_message.server_id, v_actor_id)"
        )
        self.assertEqual(self.normalized.count(authorization), 2)
        self.assertEqual(
            self.normalized.count(
                "raise exception 'message deletion requires author or server manager'"
            ),
            2,
        )
        self.assertEqual(
            self.normalized.count(
                "not public.is_server_member(v_message.server_id, v_actor_id)"
            ),
            2,
        )

    def test_attachment_paths_are_scoped_to_original_message_author(self):
        self.assertIn(
            "attachment.user_id is distinct from v_message.user_id",
            self.normalized,
        )
        self.assertIn(
            "v_message.channel_id::text || '/' || v_message.user_id::text || '/%'",
            self.normalized,
        )
        self.assertIn(
            "v_message.channel_id, v_message.user_id from public.message_attachments",
            self.normalized,
        )

    def test_existing_cleanup_lock_and_cascades_remain_in_the_pipeline(self):
        self.assertIn("for update of message", self.normalized)
        self.assertIn("delete from public.server_resources", self.normalized)
        self.assertIn(
            "other_attachment.message_id <> p_message_id",
            self.normalized,
        )
        self.assertIn("delete from public.messages where id = p_message_id", self.normalized)
        self.assertNotIn("delete from public.message_attachments", self.normalized)
        self.assertNotIn("delete from public.pinned_messages", self.normalized)


if __name__ == "__main__":
    unittest.main()
