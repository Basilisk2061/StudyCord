import asyncio
import io
import os
import sqlite3
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.datastructures import Headers, UploadFile


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from rag1.db import RagDocumentRepository, RagSessionRepository
from rag1.ingestion import (
    MAX_UPLOAD_BYTES,
    RagIngestionError,
    ingest_rag_document,
)
from rag1.paths import (
    DOCUMENT_TEXT_FILENAME,
    FAISS_DOCSTORE_FILENAME,
    FAISS_INDEX_FILENAME,
    get_document_directory,
)
from rag1.service import clear_rag_document_cache, is_rag_document_cached


class FakeVectorStore:
    def __init__(self, documents):
        self.documents = documents

    def save_local(self, folder_path):
        folder = Path(folder_path)
        (folder / FAISS_INDEX_FILENAME).write_bytes(b"fake-faiss-index")
        (folder / FAISS_DOCSTORE_FILENAME).write_bytes(b"fake-docstore")

    def similarity_search(self, _question, k=4):
        return self.documents[:k]


class FailingSaveVectorStore(FakeVectorStore):
    def save_local(self, folder_path):
        raise OSError("simulated FAISS save failure")


class FailingReadyRepository(RagDocumentRepository):
    def update_status_for_user(self, *args, **kwargs):
        raise sqlite3.OperationalError("simulated ready update failure")


class FakeChatResponse:
    def __init__(self, content):
        self.content = content


class FakeChatModel:
    async def ainvoke(self, prompt, **_kwargs):
        if "revision flashcards" in prompt:
            return FakeChatResponse(
                '[{"question":"What is supervised learning?",'
                '"answer":"Learning from labelled examples."}]'
            )
        if "multiple-choice questions" in prompt:
            return FakeChatResponse(
                '[{"question":"Which data is used?",'
                '"options":["Labelled","Random","None","Only images"],'
                '"correct_answer":"Labelled"}]'
            )
        if "structured summary" in prompt:
            return FakeChatResponse(
                '{"executive_summary":"A short summary.",'
                '"key_concepts":[],"key_points":[]}'
            )
        return FakeChatResponse(
            '{"answer":"The document discusses supervised learning."}'
        )


def make_upload(filename: str, content: bytes, content_type: str) -> UploadFile:
    return UploadFile(
        io.BytesIO(content),
        filename=filename,
        headers=Headers({"content-type": content_type}),
    )


class Rag1IngestionTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temporary_directory.name) / "rag1"
        self.user_id = str(uuid.uuid4())
        self.repository = RagDocumentRepository(self.data_dir)
        self.fake_vector_builder = lambda documents, _embeddings: FakeVectorStore(
            documents
        )

    def tearDown(self):
        main.app.dependency_overrides.clear()
        clear_rag_document_cache()
        main._generation_cache.clear()
        self.temporary_directory.cleanup()

    def ingest(self, upload, *, repository=None, vector_builder=None):
        with (
            patch("rag1.ingestion._build_embeddings", return_value=object()),
            patch(
                "rag1.ingestion._build_vector_store",
                side_effect=vector_builder or self.fake_vector_builder,
            ),
        ):
            return asyncio.run(
                ingest_rag_document(
                    upload,
                    self.user_id,
                    repository=repository or self.repository,
                )
            )

    def assert_no_staging_entries(self):
        self.assertEqual(list((self.data_dir / ".staging").iterdir()), [])

    def test_unauthenticated_upload_is_rejected(self):
        with (
            patch.dict(
                os.environ,
                {
                    "RAG1_DATA_DIR": str(self.data_dir),
                    "GOOGLE_API_KEY": "phase17-test-key",
                },
            ),
            TestClient(main.app) as client,
        ):
            response = client.post(
                "/api/rag/upload",
                files={"file": ("notes.txt", b"study notes", "text/plain")},
            )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.repository.list_for_user(self.user_id), [])

    def test_authenticated_txt_upload_persists_and_populates_current_cache(self):
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": self.user_id,
            "email": "not-used@example.invalid",
            "supabase_user": None,
        }

        with (
            patch.dict(
                os.environ,
                {
                    "RAG1_DATA_DIR": str(self.data_dir),
                    "GOOGLE_API_KEY": "phase17-test-key",
                },
            ),
            patch("rag1.ingestion._build_embeddings", return_value=object()),
            patch(
                "rag1.ingestion._build_vector_store",
                side_effect=self.fake_vector_builder,
            ),
            patch.object(
                main.llm_provider_manager,
                "generate",
                side_effect=FakeChatModel().ainvoke,
            ),
            TestClient(main.app) as client,
        ):
            response = client.post(
                "/api/rag/upload",
                files={
                    "file": (
                        "../../private-notes.txt",
                        b"Supervised learning uses labelled training examples.",
                        "text/plain",
                    )
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            doc_id = response.json()["doc_id"]
            feature_responses = [
                client.post("/api/rag/summary", json={"doc_id": doc_id}),
                client.post("/api/rag/flashcards", json={"doc_id": doc_id}),
                client.post("/api/rag/mcq", json={"doc_id": doc_id}),
                client.post(
                    "/api/rag/chat",
                    json={
                        "doc_id": doc_id,
                        "question": "What does this document discuss?",
                    },
                ),
            ]

        payload = response.json()
        uuid.UUID(doc_id)
        uuid.UUID(payload["session_id"])
        self.assertEqual(payload["filename"], "private-notes.txt")
        self.assertTrue(is_rag_document_cached(self.user_id, doc_id))
        self.assertTrue(
            all(feature_response.status_code == 200 for feature_response in feature_responses),
            [feature_response.text for feature_response in feature_responses],
        )

        metadata = self.repository.get_for_user(doc_id, self.user_id)
        self.assertIsNotNone(metadata)
        self.assertEqual(metadata.user_id, self.user_id)
        self.assertEqual(metadata.status, "ready")
        self.assertEqual(metadata.detected_type, "txt")
        self.assertGreater(metadata.chunk_count, 0)
        sessions = RagSessionRepository(self.data_dir).list_for_user(self.user_id)
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0].id, payload["session_id"])
        self.assertEqual(sessions[0].document_id, doc_id)
        self.assertEqual(sessions[0].user_id, self.user_id)

        document_directory = get_document_directory(
            self.user_id,
            doc_id,
            self.data_dir,
        )
        self.assertEqual(
            (document_directory / DOCUMENT_TEXT_FILENAME).read_text(
                encoding="utf-8"
            ),
            "Supervised learning uses labelled training examples.",
        )
        self.assertTrue((document_directory / FAISS_INDEX_FILENAME).is_file())
        self.assertTrue((document_directory / FAISS_DOCSTORE_FILENAME).is_file())
        self.assertFalse((self.data_dir / "private-notes.txt").exists())
        self.assert_no_staging_entries()

    def test_valid_pdf_upload_uses_existing_extraction_shape(self):
        class FakePage:
            def extract_text(self):
                return "Text extracted from a PDF page."

        class FakeReader:
            pages = [FakePage()]

        upload = make_upload(
            "lecture.pdf",
            b"%PDF-1.7\nfake-test-pdf",
            "application/pdf",
        )
        with patch("pypdf.PdfReader", return_value=FakeReader()):
            result = self.ingest(upload)

        self.assertEqual(result.detected_type, "pdf")
        self.assertEqual(result.text, "Text extracted from a PDF page.")
        self.assertEqual(
            self.repository.get_for_user(result.doc_id, self.user_id).status,
            "ready",
        )

    def test_valid_docx_upload(self):
        import docx

        buffer = io.BytesIO()
        document = docx.Document()
        document.add_paragraph("Persistent DOCX study content.")
        document.save(buffer)

        result = self.ingest(
            make_upload(
                "lecture.docx",
                buffer.getvalue(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
        )

        self.assertEqual(result.detected_type, "docx")
        self.assertEqual(result.text, "Persistent DOCX study content.")
        self.assertTrue(
            (
                get_document_directory(
                    self.user_id,
                    result.doc_id,
                    self.data_dir,
                )
                / FAISS_DOCSTORE_FILENAME
            ).is_file()
        )

    def test_unsupported_empty_and_empty_text_uploads_are_rejected(self):
        cases = [
            make_upload("notes.exe", b"not allowed", "application/octet-stream"),
            make_upload("notes.txt", b"", "text/plain"),
            make_upload("notes.txt", b" \r\n\t ", "text/plain"),
            make_upload("broken.pdf", b"not-a-pdf", "application/pdf"),
        ]

        for upload in cases:
            with self.subTest(filename=upload.filename):
                with self.assertRaises(RagIngestionError) as raised:
                    self.ingest(upload)
                self.assertIn(raised.exception.status_code, {400, 413})

        self.assertEqual(self.repository.list_for_user(self.user_id), [])
        self.assert_no_staging_entries()

    def test_oversized_upload_is_rejected(self):
        upload = make_upload(
            "large.txt",
            b"a" * (MAX_UPLOAD_BYTES + 1),
            "text/plain",
        )

        with self.assertRaises(RagIngestionError) as raised:
            self.ingest(upload)

        self.assertEqual(raised.exception.status_code, 413)
        self.assertEqual(self.repository.list_for_user(self.user_id), [])

    def test_embedding_failure_cleans_metadata_and_staging(self):
        upload = make_upload("notes.txt", b"usable text", "text/plain")
        with (
            patch(
                "rag1.ingestion._build_embeddings",
                side_effect=RuntimeError("simulated provider failure"),
            ),
            self.assertRaises(RagIngestionError) as raised,
        ):
            asyncio.run(
                ingest_rag_document(
                    upload,
                    self.user_id,
                    repository=self.repository,
                )
            )

        self.assertEqual(raised.exception.status_code, 502)
        self.assertEqual(self.repository.list_for_user(self.user_id), [])
        self.assert_no_staging_entries()
        self.assertEqual(list((self.data_dir / "users").iterdir()), [])

    def test_faiss_save_failure_cleans_metadata_and_staging(self):
        with self.assertRaises(RagIngestionError):
            self.ingest(
                make_upload("notes.txt", b"usable text", "text/plain"),
                vector_builder=lambda documents, _embeddings: FailingSaveVectorStore(
                    documents
                ),
            )

        self.assertEqual(self.repository.list_for_user(self.user_id), [])
        self.assert_no_staging_entries()

    def test_ready_metadata_failure_removes_promoted_artifacts(self):
        failing_repository = FailingReadyRepository(self.data_dir)

        with self.assertRaises(RagIngestionError):
            self.ingest(
                make_upload("notes.txt", b"usable text", "text/plain"),
                repository=failing_repository,
            )

        self.assertEqual(failing_repository.list_for_user(self.user_id), [])
        self.assert_no_staging_entries()
        user_directory = self.data_dir / "users" / self.user_id
        self.assertFalse(user_directory.exists() and any(user_directory.iterdir()))


if __name__ == "__main__":
    unittest.main()
