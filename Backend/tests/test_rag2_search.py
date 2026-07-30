import asyncio
import math
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from rag2.embeddings import (
    EMBEDDING_DIMENSIONS,
    Rag2EmbeddingError,
    embed_search_query,
)
from rag2.schemas import Rag2ChunkHit
from rag2.search import Rag2SearchError, search_server_chunks


MIGRATION_PATH = (
    BACKEND_DIR
    / "migrations"
    / "20260730_phase18_3_rag2_hnsw_retrieval.sql"
)


class FakeQueryEmbeddings:
    def __init__(self, vector=None, error=None):
        self.vector = vector
        self.error = error
        self.calls = []

    async def aembed_query(self, query, **kwargs):
        self.calls.append((query, kwargs))
        if self.error:
            raise self.error
        if self.vector is not None:
            return self.vector
        return [1.0] + [0.0] * (EMBEDDING_DIMENSIONS - 1)


class FakeSearchClient:
    def __init__(self, rows=None, error=None):
        self.rows = rows or []
        self.error = error
        self.calls = []

    async def rpc(self, function_name, payload):
        self.calls.append((function_name, payload))
        if self.error:
            raise self.error
        return self.rows


class FakeEndpointClient:
    def __init__(self, role="member"):
        self.role = role
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
        self.calls.append(("rest", path))
        if path == "server_members":
            return [{"role": self.role}] if self.role else []
        raise AssertionError(path)

    async def rpc(self, function_name, payload):
        self.calls.append(("rpc", function_name))
        return []


def chunk_row(server_id, *, distance=0.2, **overrides):
    row = {
        "server_id": server_id,
        "resource_id": str(uuid.uuid4()),
        "chunk_id": str(uuid.uuid4()),
        "chunk_index": 0,
        "content": "Relevant academic chunk.",
        "cosine_distance": distance,
        "cosine_similarity": 1 - distance,
        "embedding": [1.0, 0.0],
        "storage_path": "must/not/leak.pdf",
        "uploader_id": str(uuid.uuid4()),
    }
    row.update(overrides)
    return row


class Rag2SearchMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = MIGRATION_PATH.read_text(encoding="utf-8").lower()

    def test_hnsw_cosine_index_uses_defaults_and_no_ivfflat(self):
        self.assertIn(
            "create index idx_resource_chunks_embedding_hnsw_cosine",
            self.sql,
        )
        self.assertIn("using hnsw (embedding extensions.vector_cosine_ops)", self.sql)
        self.assertNotIn("using ivfflat", self.sql)
        self.assertNotIn("ef_construction =", self.sql)
        self.assertNotIn("with (m =", self.sql)

    def test_rpc_has_vector_768_membership_and_strict_iterative_scan(self):
        self.assertIn("match_server_resource_chunks", self.sql)
        self.assertIn("p_query_embedding extensions.vector(768)", self.sql)
        self.assertIn(
            "public.is_server_member(p_server_id, v_actor_id)",
            self.sql,
        )
        self.assertIn("'hnsw.iterative_scan'", self.sql)
        self.assertIn("'strict_order'", self.sql)
        self.assertIn("p_limit not between 1 and 25", self.sql)
        self.assertIn("security definer", self.sql)
        self.assertIn("set search_path = ''", self.sql)

    def test_rpc_filters_server_ready_visibility_model_and_dimension(self):
        self.assertIn("where chunk.server_id = p_server_id", self.sql)
        self.assertIn("resource.server_id = p_server_id", self.sql)
        self.assertIn("resource.index_status = 'ready'", self.sql)
        self.assertIn("resource.visibility = 'server'", self.sql)
        self.assertIn(
            "resource.embedding_model = 'models/gemini-embedding-001'",
            self.sql,
        )
        self.assertIn("resource.embedding_dimensions = 768", self.sql)
        self.assertIn("operator(extensions.<=>)", self.sql)

    def test_rpc_returns_safe_chunk_fields_and_restricts_execution(self):
        for field in (
            "server_id uuid",
            "resource_id uuid",
            "chunk_id uuid",
            "chunk_index integer",
            "content text",
            "cosine_distance double precision",
            "cosine_similarity double precision",
        ):
            self.assertIn(field, self.sql)
        self.assertIn("from public, anon", self.sql)
        self.assertIn("to authenticated", self.sql)
        self.assertNotIn("to service_role", self.sql)
        self.assertNotIn("resource_ratings", self.sql)
        self.assertNotIn("group by", self.sql)


class Rag2QueryEmbeddingTests(unittest.TestCase):
    def test_query_uses_retrieval_query_768_and_normalizes(self):
        fake = FakeQueryEmbeddings(
            vector=[3.0, 4.0] + [0.0] * (EMBEDDING_DIMENSIONS - 2)
        )
        vector = asyncio.run(embed_search_query("  machine learning  ", embeddings=fake))
        query, kwargs = fake.calls[0]
        self.assertEqual(query, "machine learning")
        self.assertEqual(kwargs["task_type"], "RETRIEVAL_QUERY")
        self.assertEqual(kwargs["output_dimensionality"], 768)
        self.assertEqual(len(vector), 768)
        self.assertAlmostEqual(math.sqrt(sum(value * value for value in vector)), 1.0)

    def test_query_rejects_provider_bad_dimension_nonfinite_and_zero(self):
        cases = (
            FakeQueryEmbeddings(error=RuntimeError("provider")),
            FakeQueryEmbeddings(vector=[]),
            FakeQueryEmbeddings(vector=["invalid"] * 768),
            FakeQueryEmbeddings(vector=[1.0]),
            FakeQueryEmbeddings(vector=[float("inf")] + [0.0] * 767),
            FakeQueryEmbeddings(vector=[0.0] * 768),
        )
        for fake in cases:
            with self.subTest(fake=fake):
                with self.assertRaises(Rag2EmbeddingError):
                    asyncio.run(embed_search_query("query", embeddings=fake))

    def test_document_embedding_function_remains_separate(self):
        source = (
            BACKEND_DIR / "rag2" / "embeddings.py"
        ).read_text(encoding="utf-8")
        self.assertIn('task_type="RETRIEVAL_DOCUMENT"', source)
        self.assertIn('task_type="RETRIEVAL_QUERY"', source)


class Rag2SearchServiceTests(unittest.TestCase):
    def setUp(self):
        self.server_id = str(uuid.uuid4())
        self.embeddings = FakeQueryEmbeddings()

    def test_search_calls_caller_rpc_and_preserves_cosine_order(self):
        client = FakeSearchClient(
            rows=[
                chunk_row(self.server_id, distance=0.1),
                chunk_row(self.server_id, distance=0.3, chunk_index=1),
            ]
        )
        results = asyncio.run(
            search_server_chunks(
                client,
                self.server_id,
                "machine learning",
                limit=2,
                embeddings=self.embeddings,
            )
        )
        self.assertEqual([hit.cosine_distance for hit in results], [0.1, 0.3])
        function_name, payload = client.calls[0]
        self.assertEqual(function_name, "match_server_resource_chunks")
        self.assertEqual(payload["p_server_id"], self.server_id)
        self.assertEqual(payload["p_limit"], 2)
        self.assertEqual(len(payload["p_query_embedding"]), 768)

    def test_empty_database_result_succeeds(self):
        results = asyncio.run(
            search_server_chunks(
                FakeSearchClient(),
                self.server_id,
                "nothing found",
                embeddings=self.embeddings,
            )
        )
        self.assertEqual(results, [])

    def test_result_schema_drops_embedding_and_storage_metadata(self):
        results = asyncio.run(
            search_server_chunks(
                FakeSearchClient(rows=[chunk_row(self.server_id)]),
                self.server_id,
                "safe result",
                embeddings=self.embeddings,
            )
        )
        payload = results[0].model_dump(mode="json")
        self.assertEqual(
            set(payload),
            {
                "server_id",
                "resource_id",
                "chunk_id",
                "chunk_index",
                "content",
                "cosine_distance",
                "cosine_similarity",
            },
        )

    def test_cross_server_and_bad_order_are_rejected(self):
        cases = (
            [chunk_row(str(uuid.uuid4()))],
            [
                chunk_row(self.server_id, distance=0.4),
                chunk_row(self.server_id, distance=0.2, chunk_index=1),
            ],
        )
        for rows in cases:
            with self.subTest(rows=rows):
                with self.assertRaises(Rag2SearchError) as raised:
                    asyncio.run(
                        search_server_chunks(
                            FakeSearchClient(rows=rows),
                            self.server_id,
                            "query",
                            embeddings=self.embeddings,
                        )
                    )
                self.assertEqual(raised.exception.status_code, 500)

    def test_provider_and_database_failures_are_controlled(self):
        with self.assertRaises(Rag2SearchError) as provider:
            asyncio.run(
                search_server_chunks(
                    FakeSearchClient(),
                    self.server_id,
                    "query",
                    embeddings=FakeQueryEmbeddings(error=RuntimeError("provider")),
                )
            )
        self.assertEqual(provider.exception.status_code, 502)

        with self.assertRaises(Rag2SearchError) as database:
            asyncio.run(
                search_server_chunks(
                    FakeSearchClient(error=RuntimeError("database")),
                    self.server_id,
                    "query",
                    embeddings=self.embeddings,
                )
            )
        self.assertEqual(database.exception.status_code, 500)

        with self.assertRaises(Rag2SearchError) as membership:
            asyncio.run(
                search_server_chunks(
                    FakeSearchClient(
                        error=HTTPException(
                            status_code=403,
                            detail="membership required",
                        )
                    ),
                    self.server_id,
                    "query",
                    embeddings=self.embeddings,
                )
            )
        self.assertEqual(membership.exception.status_code, 403)


class Rag2SearchEndpointTests(unittest.TestCase):
    def setUp(self):
        self.user_id = str(uuid.uuid4())
        self.server_id = str(uuid.uuid4())

    def tearDown(self):
        main.app.dependency_overrides.clear()

    def authenticate(self, client):
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": self.user_id,
            "email": None,
            "supabase_user": client,
        }

    def test_unauthenticated_and_nonmember_are_denied_before_search(self):
        with TestClient(main.app) as api:
            unauthenticated = api.post(
                f"/api/rag2/servers/{self.server_id}/search",
                json={"query": "machine learning"},
            )
        self.assertEqual(unauthenticated.status_code, 401)

        caller = FakeEndpointClient(role=None)
        self.authenticate(caller)
        with (
            patch("main.search_server_chunks", new=AsyncMock()) as search,
            TestClient(main.app) as api,
        ):
            forbidden = api.post(
                f"/api/rag2/servers/{self.server_id}/search",
                json={"query": "machine learning"},
            )
        self.assertEqual(forbidden.status_code, 403)
        search.assert_not_awaited()
        self.assertEqual(caller.calls, [("rest", "server_members")])

    def test_member_search_authorizes_before_embedding_service(self):
        caller = FakeEndpointClient(role="member")
        self.authenticate(caller)
        hit = Rag2ChunkHit.model_validate(chunk_row(self.server_id))
        with (
            patch(
                "main.search_server_chunks",
                new=AsyncMock(return_value=[hit]),
            ) as search,
            patch("main.supabase_admin") as admin,
            TestClient(main.app) as api,
        ):
            response = api.post(
                f"/api/rag2/servers/{self.server_id}/search",
                json={"query": "  machine learning  ", "limit": 5},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(caller.calls[0], ("rest", "server_members"))
        search.assert_awaited_once_with(
            caller,
            self.server_id,
            "machine learning",
            limit=5,
        )
        admin.assert_not_called()
        payload = response.json()
        self.assertEqual(payload["query"], "machine learning")
        self.assertNotIn("embedding", response.text)
        self.assertNotIn("storage_path", response.text)

    def test_query_uuid_and_limit_validation(self):
        caller = FakeEndpointClient(role="member")
        self.authenticate(caller)
        cases = (
            (
                f"/api/rag2/servers/{self.server_id}/search",
                {"query": "   "},
            ),
            (
                f"/api/rag2/servers/{self.server_id}/search",
                {"query": "x" * 1001},
            ),
            (
                f"/api/rag2/servers/{self.server_id}/search",
                {"query": "valid", "limit": 0},
            ),
            (
                f"/api/rag2/servers/{self.server_id}/search",
                {"query": "valid", "limit": 26},
            ),
            (
                "/api/rag2/servers/not-a-uuid/search",
                {"query": "valid"},
            ),
        )
        with TestClient(main.app) as api:
            for path, body in cases:
                with self.subTest(path=path, body=body):
                    response = api.post(path, json=body)
                    self.assertEqual(response.status_code, 422)

    def test_empty_result_and_failures_have_approved_statuses(self):
        caller = FakeEndpointClient(role="member")
        self.authenticate(caller)
        with (
            patch(
                "main.search_server_chunks",
                new=AsyncMock(return_value=[]),
            ),
            TestClient(main.app) as api,
        ):
            empty = api.post(
                f"/api/rag2/servers/{self.server_id}/search",
                json={"query": "no result"},
            )
        self.assertEqual(empty.status_code, 200)
        self.assertEqual(empty.json()["results"], [])

        for status in (502, 500):
            with (
                patch(
                    "main.search_server_chunks",
                    new=AsyncMock(
                        side_effect=Rag2SearchError(status, "safe failure")
                    ),
                ),
                TestClient(main.app) as api,
            ):
                response = api.post(
                    f"/api/rag2/servers/{self.server_id}/search",
                    json={"query": "failure"},
                )
            self.assertEqual(response.status_code, status)


if __name__ == "__main__":
    unittest.main()
