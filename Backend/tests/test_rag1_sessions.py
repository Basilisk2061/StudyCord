import os
import sqlite3
import sys
import tempfile
import unittest
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from langchain_core.documents import Document


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from rag1.db import (
    RagDocument,
    RagDocumentRepository,
    RagSessionRepository,
)
from rag1.paths import (
    DOCUMENT_TEXT_FILENAME,
    FAISS_DOCSTORE_FILENAME,
    FAISS_INDEX_FILENAME,
    get_document_directory,
)
from rag1.service import clear_rag_document_cache
from rag1.sessions import open_study_session


class FakeVectorStore:
    def similarity_search(self, _question, k=4):
        return [Document(page_content="Restored session document context.")][:k]


class FakeChatResponse:
    def __init__(self, content):
        self.content = content


class FakeChatModel:
    async def ainvoke(self, prompt, **_kwargs):
        if "structured summary" in prompt:
            return FakeChatResponse(
                '{"executive_summary":"Session summary.",'
                '"key_concepts":[],"key_points":[]}'
            )
        return FakeChatResponse('{"answer":"Session answer."}')


class Rag1SessionTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temporary_directory.name) / "rag1"
        self.environment = patch.dict(
            os.environ,
            {
                "RAG1_DATA_DIR": str(self.data_dir),
                "GOOGLE_API_KEY": "phase17-session-test-key",
            },
        )
        self.environment.start()
        self.documents = RagDocumentRepository(self.data_dir)
        self.sessions = RagSessionRepository(self.data_dir)
        self.user_a = str(uuid.uuid4())
        self.user_b = str(uuid.uuid4())

    def tearDown(self):
        main.app.dependency_overrides.clear()
        main._generation_cache.clear()
        clear_rag_document_cache()
        self.environment.stop()
        self.temporary_directory.cleanup()

    def authenticate_as(self, user_id):
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": user_id,
            "email": None,
            "supabase_user": None,
        }

    def create_document(
        self,
        *,
        user_id=None,
        filename="study-notes.txt",
        status="ready",
    ):
        owner_id = user_id or self.user_a
        document_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        text = f"Persistent text for {filename}."
        self.documents.create(
            RagDocument(
                id=document_id,
                user_id=owner_id,
                original_filename=filename,
                detected_type="txt",
                size_bytes=len(text.encode("utf-8")),
                status=status,
                chunk_count=1 if status == "ready" else None,
                artifact_version=1,
                created_at=now,
                updated_at=now,
            )
        )
        if status == "ready":
            directory = get_document_directory(
                owner_id,
                document_id,
                self.data_dir,
            )
            directory.mkdir(parents=True)
            (directory / DOCUMENT_TEXT_FILENAME).write_text(
                text,
                encoding="utf-8",
            )
            (directory / FAISS_INDEX_FILENAME).write_bytes(b"test-index")
            (directory / FAISS_DOCSTORE_FILENAME).write_bytes(b"test-docstore")
        return document_id

    def create_session(
        self,
        document_id,
        *,
        user_id=None,
        title="Study Notes.txt",
        timestamp="2026-07-28T00:00:00+00:00",
    ):
        return self.sessions.create_for_document(
            user_id or self.user_a,
            document_id,
            title,
            timestamp,
        )

    def test_session_repository_generates_uuid_links_and_orders_history(self):
        first_document = self.create_document(filename="first.txt")
        second_document = self.create_document(filename="second.txt")
        first = self.create_session(
            first_document,
            title="First Study",
            timestamp="2026-07-28T01:00:00+00:00",
        )
        second = self.create_session(
            second_document,
            title="Second Study",
            timestamp="2026-07-28T02:00:00+00:00",
        )

        uuid.UUID(first.id)
        uuid.UUID(second.id)
        self.assertEqual(first.user_id, self.user_a)
        self.assertEqual(first.document_id, first_document)
        with self.assertRaises(ValueError):
            self.sessions.create_for_document(
                self.user_b,
                first_document,
                "Cross-owner session",
                "2026-07-28T03:00:00+00:00",
            )
        self.assertEqual(
            [session.id for session in self.sessions.list_for_user(self.user_a)],
            [second.id, first.id],
        )
        self.assertEqual(self.sessions.list_for_user(self.user_b), [])

        restarted = RagSessionRepository(self.data_dir)
        self.assertEqual(
            [session.id for session in restarted.list_for_user(self.user_a)],
            [second.id, first.id],
        )

    def test_history_requires_auth_and_returns_only_safe_owned_metadata(self):
        own_document = self.create_document(filename="owned.txt")
        own_session = self.create_session(own_document, title="Owned Study")
        other_document = self.create_document(
            user_id=self.user_b,
            filename="other.txt",
        )
        self.create_session(
            other_document,
            user_id=self.user_b,
            title="Other Study",
        )

        with TestClient(main.app) as client:
            unauthenticated = client.get("/api/rag/sessions")

        self.authenticate_as(self.user_a)
        with TestClient(main.app) as client:
            authenticated = client.get("/api/rag/sessions")

        self.assertEqual(unauthenticated.status_code, 401)
        self.assertEqual(authenticated.status_code, 200)
        payload = authenticated.json()
        self.assertEqual(len(payload), 1)
        self.assertEqual(payload[0]["id"], own_session.id)
        self.assertEqual(
            set(payload[0]),
            {
                "id",
                "document_id",
                "title",
                "original_filename",
                "detected_type",
                "created_at",
                "updated_at",
            },
        )
        self.assertNotIn(self.user_a, authenticated.text)
        self.assertNotIn(str(self.data_dir), authenticated.text)

    def test_open_session_is_owned_non_leaking_and_touches_updated_at(self):
        document_id = self.create_document()
        session = self.create_session(document_id)

        self.authenticate_as(self.user_b)
        with TestClient(main.app) as client:
            cross_user = client.get(f"/api/rag/sessions/{session.id}")

        self.authenticate_as(self.user_a)
        with TestClient(main.app) as client:
            invalid = client.get("/api/rag/sessions/not-a-uuid")
            missing = client.get(f"/api/rag/sessions/{uuid.uuid4()}")
            opened = client.get(f"/api/rag/sessions/{session.id}")

        self.assertEqual(cross_user.status_code, 404)
        self.assertEqual(invalid.status_code, 404)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(opened.status_code, 200)
        self.assertEqual(opened.json()["document_id"], document_id)
        self.assertGreater(opened.json()["updated_at"], session.updated_at)

    def test_missing_and_non_ready_associated_documents_are_safe(self):
        missing_document_id = self.create_document(filename="missing.txt")
        missing_session = self.create_session(missing_document_id)
        with closing(sqlite3.connect(self.sessions.database_path)) as connection:
            connection.execute(
                "delete from rag_documents where id = ?",
                (missing_document_id,),
            )
            connection.commit()

        non_ready_document_id = self.create_document(filename="waiting.txt")
        non_ready_session = self.create_session(non_ready_document_id)
        self.documents.update_status_for_user(
            non_ready_document_id,
            self.user_a,
            "processing",
            datetime.now(timezone.utc).isoformat(),
            chunk_count=None,
        )

        self.authenticate_as(self.user_a)
        with TestClient(main.app) as client:
            missing = client.get(
                f"/api/rag/sessions/{missing_session.id}"
            )
            non_ready = client.get(
                f"/api/rag/sessions/{non_ready_session.id}"
            )

        self.assertEqual(missing.status_code, 404)
        self.assertEqual(non_ready.status_code, 409)
        self.assertNotIn(str(self.data_dir), missing.text)

    def test_open_does_not_ingest_embed_or_duplicate_artifacts(self):
        document_id = self.create_document()
        session = self.create_session(document_id)
        document_directory = get_document_directory(
            self.user_a,
            document_id,
            self.data_dir,
        )
        artifacts_before = sorted(path.name for path in document_directory.iterdir())
        documents_before = self.documents.list_for_user(self.user_a)

        self.authenticate_as(self.user_a)
        with (
            patch("main.ingest_rag_document") as ingest,
            patch("rag1.ingestion._build_embeddings") as build_embeddings,
            patch("rag1.service._load_vector_store") as load_vector_store,
            TestClient(main.app) as client,
        ):
            response = client.get(f"/api/rag/sessions/{session.id}")

        self.assertEqual(response.status_code, 200)
        ingest.assert_not_called()
        build_embeddings.assert_not_called()
        load_vector_store.assert_not_called()
        self.assertEqual(
            sorted(path.name for path in document_directory.iterdir()),
            artifacts_before,
        )
        self.assertEqual(
            self.documents.list_for_user(self.user_a),
            documents_before,
        )

    def test_failed_ingestion_creates_no_session(self):
        self.authenticate_as(self.user_a)
        with (
            patch(
                "rag1.ingestion._build_embeddings",
                side_effect=RuntimeError("simulated embedding failure"),
            ),
            TestClient(main.app) as client,
        ):
            response = client.post(
                "/api/rag/upload",
                files={"file": ("failure.txt", b"usable text", "text/plain")},
            )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.sessions.list_for_user(self.user_a), [])
        self.assertEqual(self.documents.list_for_user(self.user_a), [])

    def test_restart_history_open_and_lazy_rag_restoration(self):
        document_id = self.create_document(filename="restart.txt")
        session = self.create_session(document_id, title="Restart Study")

        restarted_sessions = RagSessionRepository(self.data_dir)
        self.assertEqual(
            restarted_sessions.list_for_user(self.user_a)[0].id,
            session.id,
        )
        opened_directly = open_study_session(
            self.user_a,
            session.id,
            repository=restarted_sessions,
        )
        self.assertEqual(opened_directly.document_id, document_id)

        clear_rag_document_cache()
        self.authenticate_as(self.user_a)
        with (
            patch(
                "rag1.service._load_vector_store",
                return_value=FakeVectorStore(),
            ) as load_vector_store,
            patch.object(
                main.llm_provider_manager,
                "generate",
                side_effect=FakeChatModel().ainvoke,
            ),
            patch("rag1.ingestion._build_embeddings") as build_embeddings,
            TestClient(main.app) as client,
        ):
            history = client.get("/api/rag/sessions")
            opened = client.get(f"/api/rag/sessions/{session.id}")
            summary = client.post(
                "/api/rag/summary",
                json={"doc_id": document_id},
            )
            chat = client.post(
                "/api/rag/chat",
                json={"doc_id": document_id, "question": "What persisted?"},
            )

        self.assertEqual(history.status_code, 200)
        self.assertEqual(opened.status_code, 200)
        self.assertEqual(summary.status_code, 200)
        self.assertEqual(chat.status_code, 200)
        load_vector_store.assert_called_once()
        build_embeddings.assert_not_called()
        self.assertEqual(len(self.sessions.list_for_user(self.user_a)), 1)
        self.assertEqual(len(self.documents.list_for_user(self.user_a)), 1)


if __name__ == "__main__":
    unittest.main()
