import sqlite3
import sys
import tempfile
import unittest
import uuid
from contextlib import closing
from unittest.mock import patch
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from rag1 import initialize_rag1_persistence
from rag1.db import RagDocument, RagDocumentRepository
from rag1.paths import (
    DOCUMENT_TEXT_FILENAME,
    create_staging_directory,
    ensure_data_directories,
    get_document_artifact_path,
    get_document_directory,
    get_user_directory,
    promote_staging_directory,
    remove_staging_directory,
    validate_uuid,
)


class Rag1PersistenceFoundationTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temporary_directory.name) / "rag1"
        self.user_id = str(uuid.uuid4())
        self.other_user_id = str(uuid.uuid4())
        self.document_id = str(uuid.uuid4())

    def tearDown(self):
        self.temporary_directory.cleanup()

    def _document(self) -> RagDocument:
        return RagDocument(
            id=self.document_id,
            user_id=self.user_id,
            original_filename="lecture-notes.pdf",
            detected_type="pdf",
            size_bytes=1024,
            status="processing",
            chunk_count=None,
            artifact_version=1,
            created_at="2026-07-28T00:00:00+00:00",
            updated_at="2026-07-28T00:00:00+00:00",
        )

    def test_initialization_creates_directories_schema_and_indexes(self):
        persistence = initialize_rag1_persistence(self.data_dir)

        self.assertEqual(persistence.data_dir, self.data_dir.resolve())
        self.assertTrue(persistence.database_path.is_file())
        self.assertTrue((self.data_dir / "users").is_dir())
        self.assertTrue((self.data_dir / ".staging").is_dir())

        with closing(sqlite3.connect(persistence.database_path)) as connection:
            columns = {
                row[1]
                for row in connection.execute("pragma table_info(rag_documents)")
            }
            indexes = {
                row[1]
                for row in connection.execute("pragma index_list(rag_documents)")
            }
            session_columns = {
                row[1]
                for row in connection.execute("pragma table_info(rag_sessions)")
            }
            session_indexes = {
                row[1]
                for row in connection.execute("pragma index_list(rag_sessions)")
            }

        self.assertEqual(
            columns,
            {
                "id",
                "user_id",
                "original_filename",
                "detected_type",
                "size_bytes",
                "status",
                "chunk_count",
                "artifact_version",
                "created_at",
                "updated_at",
            },
        )
        self.assertIn("idx_rag_documents_user_created", indexes)
        self.assertIn("idx_rag_documents_status_updated", indexes)
        self.assertEqual(
            session_columns,
            {
                "id",
                "user_id",
                "document_id",
                "title",
                "created_at",
                "updated_at",
            },
        )
        self.assertIn("idx_rag_sessions_user_updated", session_indexes)
        self.assertIn("idx_rag_sessions_document", session_indexes)

    def test_initialization_is_idempotent_and_enables_wal(self):
        first = initialize_rag1_persistence(self.data_dir)
        second = initialize_rag1_persistence(self.data_dir)

        self.assertEqual(first, second)
        with closing(sqlite3.connect(first.database_path)) as connection:
            journal_mode = connection.execute("pragma journal_mode").fetchone()[0]
            busy_timeout = connection.execute("pragma busy_timeout").fetchone()[0]

        self.assertEqual(journal_mode.lower(), "wal")
        self.assertEqual(busy_timeout, 5000)

    def test_environment_configures_data_directory(self):
        configured_directory = Path(self.temporary_directory.name) / "configured"
        with patch.dict(
            "os.environ",
            {"RAG1_DATA_DIR": str(configured_directory)},
        ):
            persistence = initialize_rag1_persistence()

        self.assertEqual(persistence.data_dir, configured_directory.resolve())
        self.assertTrue(persistence.database_path.is_file())

    def test_repository_crud_and_ownership_queries(self):
        repository = RagDocumentRepository(self.data_dir)
        created = repository.create(self._document())

        self.assertEqual(
            repository.get_for_user(self.document_id, self.user_id),
            created,
        )
        self.assertIsNone(
            repository.get_for_user(self.document_id, self.other_user_id)
        )
        self.assertEqual(repository.list_for_user(self.user_id), [created])
        self.assertEqual(repository.list_for_user(self.other_user_id), [])

        self.assertFalse(
            repository.update_status_for_user(
                self.document_id,
                self.other_user_id,
                "ready",
                "2026-07-28T00:01:00+00:00",
                chunk_count=10,
            )
        )
        self.assertTrue(
            repository.update_status_for_user(
                self.document_id,
                self.user_id,
                "ready",
                "2026-07-28T00:01:00+00:00",
                chunk_count=10,
            )
        )
        updated = repository.get_for_user(self.document_id, self.user_id)
        self.assertIsNotNone(updated)
        self.assertEqual(updated.status, "ready")
        self.assertEqual(updated.chunk_count, 10)

        self.assertFalse(
            repository.delete_for_user(self.document_id, self.other_user_id)
        )
        self.assertTrue(repository.delete_for_user(self.document_id, self.user_id))
        self.assertIsNone(
            repository.get_for_user(self.document_id, self.user_id)
        )

    def test_restart_reinitialization_preserves_metadata(self):
        first_repository = RagDocumentRepository(self.data_dir)
        created = first_repository.create(self._document())

        initialize_rag1_persistence(self.data_dir)
        restarted_repository = RagDocumentRepository(self.data_dir)

        self.assertEqual(
            restarted_repository.get_for_user(self.document_id, self.user_id),
            created,
        )

    def test_uuid_validation_and_safe_paths(self):
        self.assertEqual(str(validate_uuid(self.user_id, "user_id")), self.user_id)
        with self.assertRaises(ValueError):
            validate_uuid("../../outside", "user_id")
        with self.assertRaises(ValueError):
            get_document_directory(self.user_id, "../document", self.data_dir)

        user_directory = get_user_directory(self.user_id, self.data_dir)
        document_directory = get_document_directory(
            self.user_id,
            self.document_id,
            self.data_dir,
        )
        artifact_path = get_document_artifact_path(
            self.user_id,
            self.document_id,
            DOCUMENT_TEXT_FILENAME,
            self.data_dir,
        )

        self.assertEqual(
            user_directory,
            self.data_dir.resolve() / "users" / self.user_id,
        )
        self.assertEqual(
            document_directory,
            user_directory / self.document_id,
        )
        self.assertEqual(
            artifact_path,
            document_directory / DOCUMENT_TEXT_FILENAME,
        )
        with self.assertRaises(ValueError):
            get_document_artifact_path(
                self.user_id,
                self.document_id,
                "../../uploaded-name.pdf",
                self.data_dir,
            )

    def test_staging_creation_promotion_and_rejection(self):
        ensure_data_directories(self.data_dir)
        staging_directory = create_staging_directory(
            self.document_id,
            self.data_dir,
        )
        (staging_directory / DOCUMENT_TEXT_FILENAME).write_text(
            "processed text",
            encoding="utf-8",
        )

        final_directory = promote_staging_directory(
            staging_directory,
            self.user_id,
            self.document_id,
            self.data_dir,
        )

        self.assertFalse(staging_directory.exists())
        self.assertEqual(
            final_directory,
            get_document_directory(
                self.user_id,
                self.document_id,
                self.data_dir,
            ),
        )
        self.assertEqual(
            (final_directory / DOCUMENT_TEXT_FILENAME).read_text(encoding="utf-8"),
            "processed text",
        )

        with self.assertRaises(ValueError):
            promote_staging_directory(
                self.temporary_directory.name,
                self.user_id,
                str(uuid.uuid4()),
                self.data_dir,
            )

    def test_remove_staging_rejects_outside_path(self):
        staging_directory = create_staging_directory(
            self.document_id,
            self.data_dir,
        )
        remove_staging_directory(staging_directory, self.data_dir)
        self.assertFalse(staging_directory.exists())

        with self.assertRaises(ValueError):
            remove_staging_directory(
                self.temporary_directory.name,
                self.data_dir,
            )


if __name__ == "__main__":
    unittest.main()
