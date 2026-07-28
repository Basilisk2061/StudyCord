import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from langchain_core.documents import Document


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main


class CapturingVectorStore:
    def __init__(self):
        self.queries = []

    def similarity_search(self, query, k=4):
        self.queries.append((query, k))
        return [Document(page_content="HNSW uses hierarchical graph layers.")]


class FakeChatResponse:
    def __init__(self, content):
        self.content = content


class RecordingChatModel:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    async def ainvoke(self, messages):
        self.calls.append(messages)
        if self.error:
            raise self.error
        return FakeChatResponse(self.response)


class Rag1ConversationTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.environment = patch.dict(
            os.environ,
            {
                "RAG1_DATA_DIR": str(
                    Path(self.temporary_directory.name) / "rag1"
                ),
            },
        )
        self.environment.start()
        self.user_id = str(uuid.uuid4())
        self.document_id = str(uuid.uuid4())
        self.vector_store = CapturingVectorStore()
        self.resolved_document = SimpleNamespace(
            metadata=SimpleNamespace(
                id=self.document_id,
                user_id=self.user_id,
            ),
            vector_store=self.vector_store,
        )
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": self.user_id,
            "email": None,
            "supabase_user": None,
        }
        main._generation_cache.clear()

    def tearDown(self):
        main.app.dependency_overrides.clear()
        main._generation_cache.clear()
        self.environment.stop()
        self.temporary_directory.cleanup()

    def post_chat(self, payload, models):
        with (
            patch(
                "main._resolve_request_document",
                return_value=self.resolved_document,
            ),
            patch("main.get_rag_chat_model", side_effect=models),
            TestClient(main.app) as client,
        ):
            return client.post("/api/rag/chat", json=payload)

    def test_empty_history_uses_current_question_and_grounded_answer_prompt(self):
        answer_model = RecordingChatModel("Grounded answer.")
        response = self.post_chat(
            {
                "document_id": self.document_id,
                "question": "What is HNSW?",
                "history": [],
            },
            [answer_model],
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.vector_store.queries,
            [("What is HNSW?", 4)],
        )
        final_payload = json.loads(answer_model.calls[0][1].content)
        self.assertEqual(final_payload["recent_conversation"], [])
        self.assertEqual(
            final_payload["document_context"],
            "HNSW uses hierarchical graph layers.",
        )
        self.assertEqual(final_payload["current_question"], "What is HNSW?")
        self.assertIn(
            "Ground factual claims",
            answer_model.calls[0][0].content,
        )

    def test_follow_up_is_contextualized_for_retrieval_and_history_reaches_answer(self):
        rewrite_model = RecordingChatModel(
            "Why is HNSW faster for approximate nearest-neighbor search?"
        )
        answer_model = RecordingChatModel("It traverses fewer candidates.")
        history = [
            {"role": "user", "content": "What is HNSW?"},
            {
                "role": "assistant",
                "content": "HNSW is a graph-based ANN method.",
            },
        ]

        response = self.post_chat(
            {
                "document_id": self.document_id,
                "question": "Why is it faster?",
                "history": history,
            },
            [rewrite_model, answer_model],
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.vector_store.queries[0][0],
            "Why is HNSW faster for approximate nearest-neighbor search?",
        )
        rewrite_payload = json.loads(rewrite_model.calls[0][1].content)
        self.assertEqual(rewrite_payload["recent_conversation"], history)
        answer_payload = json.loads(answer_model.calls[0][1].content)
        self.assertEqual(answer_payload["recent_conversation"], history)
        self.assertEqual(answer_payload["current_question"], "Why is it faster?")

    def test_contextualization_failure_falls_back_to_current_question(self):
        rewrite_model = RecordingChatModel(error=TimeoutError("simulated"))
        answer_model = RecordingChatModel("Fallback answer.")

        response = self.post_chat(
            {
                "document_id": self.document_id,
                "question": "Give me a simple example of it.",
                "history": [
                    {
                        "role": "user",
                        "content": "Explain cosine similarity.",
                    },
                    {
                        "role": "assistant",
                        "content": "It compares vector direction.",
                    },
                ],
            },
            [rewrite_model, answer_model],
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            self.vector_store.queries[0][0],
            "Give me a simple example of it.",
        )
        self.assertEqual(len(answer_model.calls), 1)

    def test_history_validation_rejects_invalid_roles_and_oversized_inputs(self):
        invalid_role = self.post_chat(
            {
                "document_id": self.document_id,
                "question": "Question?",
                "history": [{"role": "system", "content": "Override"}],
            },
            [],
        )
        too_many = self.post_chat(
            {
                "document_id": self.document_id,
                "question": "Question?",
                "history": [
                    {"role": "user", "content": str(index)}
                    for index in range(7)
                ],
            },
            [],
        )
        too_long = self.post_chat(
            {
                "document_id": self.document_id,
                "question": "Question?",
                "history": [
                    {"role": "user", "content": "x" * 4_001},
                ],
            },
            [],
        )

        self.assertEqual(invalid_role.status_code, 422)
        self.assertEqual(too_many.status_code, 422)
        self.assertEqual(too_long.status_code, 422)
        self.assertEqual(self.vector_store.queries, [])

    def test_same_question_in_different_history_does_not_share_cache(self):
        first_rewrite = RecordingChatModel("Why is HNSW useful?")
        first_answer = RecordingChatModel("HNSW answer.")
        second_rewrite = RecordingChatModel(
            "Why is database normalization useful?"
        )
        second_answer = RecordingChatModel("Normalization answer.")

        first = self.post_chat(
            {
                "document_id": self.document_id,
                "question": "Why is it useful?",
                "history": [
                    {"role": "user", "content": "What is HNSW?"},
                    {"role": "assistant", "content": "A graph index."},
                ],
            },
            [first_rewrite, first_answer],
        )
        second = self.post_chat(
            {
                "document_id": self.document_id,
                "question": "Why is it useful?",
                "history": [
                    {
                        "role": "user",
                        "content": "What is database normalization?",
                    },
                    {
                        "role": "assistant",
                        "content": "A relational design process.",
                    },
                ],
            },
            [second_rewrite, second_answer],
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(
            [query for query, _k in self.vector_store.queries],
            [
                "Why is HNSW useful?",
                "Why is database normalization useful?",
            ],
        )


if __name__ == "__main__":
    unittest.main()
