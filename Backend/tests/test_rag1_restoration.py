import os
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from langchain_core.documents import Document


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from rag1.db import RagDocument, RagDocumentRepository
from rag1.paths import (
    DOCUMENT_TEXT_FILENAME,
    FAISS_DOCSTORE_FILENAME,
    FAISS_INDEX_FILENAME,
    get_document_directory,
)
from rag1.service import (
    RagDocumentResolutionError,
    cache_rag_document,
    clear_rag_document_cache,
    is_rag_document_cached,
    resolve_rag_document,
)


class FakeVectorStore:
    def __init__(self, text="Persistent retrieval context."):
        self.documents = [Document(page_content=text)]

    def similarity_search(self, _question, k=4):
        return self.documents[:k]


class FakeChatResponse:
    def __init__(self, content):
        self.content = content


class FakeChatModel:
    async def ainvoke(self, prompt, **_kwargs):
        if "revision flashcards" in prompt:
            return FakeChatResponse(
                '[{"question":"What persisted?",'
                '"answer":"The local document artifacts."}]'
            )
        if "multiple-choice questions" in prompt:
            return FakeChatResponse(
                '[{"question":"What is restored?",'
                '"options":["FAISS","Nothing","Only JWT","Supabase rows"],'
                '"correct_answer":"FAISS"}]'
            )
        if "structured summary" in prompt:
            return FakeChatResponse(
                '{"executive_summary":"Persistent document summary.",'
                '"key_concepts":[],"key_points":[]}'
            )
        return FakeChatResponse(
            '{"answer":"The persisted FAISS context was restored."}'
        )


class Rag1RestorationTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temporary_directory.name) / "rag1"
        self.environment = patch.dict(
            os.environ,
            {
                "RAG1_DATA_DIR": str(self.data_dir),
                "GOOGLE_API_KEY": "phase17-restoration-test-key",
            },
        )
        self.environment.start()
        self.repository = RagDocumentRepository(self.data_dir)
        self.user_a = str(uuid.uuid4())
        self.user_b = str(uuid.uuid4())

    def tearDown(self):
        main.app.dependency_overrides.clear()
        main._generation_cache.clear()
        clear_rag_document_cache()
        self.environment.stop()
        self.temporary_directory.cleanup()

    def create_document(
        self,
        *,
        user_id=None,
        status="ready",
        text="Persistent document text for restoration.",
    ):
        owner_id = user_id or self.user_a
        document_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        self.repository.create(
            RagDocument(
                id=document_id,
                user_id=owner_id,
                original_filename="study-notes.txt",
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
            document_directory = get_document_directory(
                owner_id,
                document_id,
                self.data_dir,
            )
            document_directory.mkdir(parents=True)
            (document_directory / DOCUMENT_TEXT_FILENAME).write_text(
                text,
                encoding="utf-8",
            )
            (document_directory / FAISS_INDEX_FILENAME).write_bytes(
                b"test-faiss-index"
            )
            (document_directory / FAISS_DOCSTORE_FILENAME).write_bytes(
                b"test-faiss-docstore"
            )
        return document_id

    def authenticate_as(self, user_id):
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": user_id,
            "email": None,
            "supabase_user": None,
        }

    def test_all_document_operations_require_authentication(self):
        document_id = str(uuid.uuid4())
        requests = [
            ("/api/rag/chat", {"doc_id": document_id, "question": "Question?"}),
            ("/api/rag/summary", {"doc_id": document_id}),
            ("/api/rag/flashcards", {"doc_id": document_id}),
            ("/api/rag/mcq", {"doc_id": document_id}),
        ]

        with TestClient(main.app) as client:
            responses = [
                client.post(path, json=payload)
                for path, payload in requests
            ]

        self.assertTrue(
            all(response.status_code == 401 for response in responses),
            [(response.status_code, response.text) for response in responses],
        )

    def test_owner_restores_all_operations_after_cache_clear(self):
        document_id = self.create_document()
        self.authenticate_as(self.user_a)
        restored_store = FakeVectorStore()
        clear_rag_document_cache()

        with (
            patch(
                "rag1.service._load_vector_store",
                return_value=restored_store,
            ) as load_vector_store,
            patch.object(
                main.llm_provider_manager,
                "generate",
                side_effect=FakeChatModel().ainvoke,
            ),
            TestClient(main.app) as client,
        ):
            responses = [
                client.post(
                    "/api/rag/chat",
                    json={"doc_id": document_id, "question": "What persisted?"},
                ),
                client.post("/api/rag/summary", json={"doc_id": document_id}),
                client.post("/api/rag/flashcards", json={"doc_id": document_id}),
                client.post("/api/rag/mcq", json={"doc_id": document_id}),
            ]

        self.assertTrue(
            all(response.status_code == 200 for response in responses),
            [response.text for response in responses],
        )
        load_vector_store.assert_called_once()
        self.assertTrue(is_rag_document_cached(self.user_a, document_id))

    def test_other_user_cannot_use_cached_document(self):
        document_id = self.create_document()
        cache_rag_document(
            self.user_a,
            document_id,
            FakeVectorStore(),
            "Secret owner text.",
            "study-notes.txt",
        )
        self.authenticate_as(self.user_b)

        with (
            patch("rag1.service._load_vector_store") as load_vector_store,
            TestClient(main.app) as client,
        ):
            response = client.post(
                "/api/rag/summary",
                json={"doc_id": document_id},
            )

        self.assertEqual(response.status_code, 404)
        load_vector_store.assert_not_called()

    def test_invalid_missing_and_non_ready_documents_are_safe(self):
        self.authenticate_as(self.user_a)
        non_ready_id = self.create_document(status="processing")

        with TestClient(main.app) as client:
            invalid = client.post(
                "/api/rag/summary",
                json={"doc_id": "../../not-a-uuid"},
            )
            missing = client.post(
                "/api/rag/summary",
                json={"doc_id": str(uuid.uuid4())},
            )
            non_ready = client.post(
                "/api/rag/summary",
                json={"doc_id": non_ready_id},
            )

        self.assertEqual(invalid.status_code, 404)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(non_ready.status_code, 409)
        self.assertNotIn(str(self.data_dir), invalid.text)

    def test_cache_miss_loads_once_without_reembedding_documents(self):
        document_id = self.create_document()
        restored_store = FakeVectorStore()
        embedding_client = object()

        with (
            patch(
                "rag1.service.GoogleGenerativeAIEmbeddings",
                return_value=embedding_client,
            ) as embeddings,
            patch(
                "rag1.service.FAISS.load_local",
                return_value=restored_store,
            ) as load_local,
            patch("rag1.service.FAISS.from_documents") as from_documents,
        ):
            first = resolve_rag_document(
                self.user_a,
                document_id,
                repository=self.repository,
            )
            second = resolve_rag_document(
                self.user_a,
                document_id,
                repository=self.repository,
            )

        self.assertIs(first.vector_store, restored_store)
        self.assertIs(second.vector_store, restored_store)
        embeddings.assert_called_once()
        load_local.assert_called_once()
        self.assertTrue(load_local.call_args.kwargs["allow_dangerous_deserialization"])
        from_documents.assert_not_called()

    def test_missing_required_artifacts_are_controlled(self):
        for filename in (
            DOCUMENT_TEXT_FILENAME,
            FAISS_INDEX_FILENAME,
            FAISS_DOCSTORE_FILENAME,
        ):
            with self.subTest(filename=filename):
                document_id = self.create_document()
                document_directory = get_document_directory(
                    self.user_a,
                    document_id,
                    self.data_dir,
                )
                (document_directory / filename).unlink()

                with self.assertRaises(RagDocumentResolutionError) as raised:
                    resolve_rag_document(
                        self.user_a,
                        document_id,
                        repository=self.repository,
                    )

                self.assertEqual(raised.exception.status_code, 503)
                self.assertNotIn(str(self.data_dir), raised.exception.detail)

    def test_corrupt_faiss_is_controlled_and_not_cached(self):
        document_id = self.create_document()

        with (
            patch(
                "rag1.service.GoogleGenerativeAIEmbeddings",
                return_value=object(),
            ),
            patch(
                "rag1.service.FAISS.load_local",
                side_effect=ValueError("corrupt test index"),
            ),
            self.assertRaises(RagDocumentResolutionError) as raised,
        ):
            resolve_rag_document(
                self.user_a,
                document_id,
                repository=self.repository,
            )

        self.assertEqual(raised.exception.status_code, 503)
        self.assertFalse(is_rag_document_cached(self.user_a, document_id))
        self.assertNotIn("corrupt test index", raised.exception.detail)


if __name__ == "__main__":
    unittest.main()
