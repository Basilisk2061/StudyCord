import asyncio
import hashlib
import math
import sys
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from rag2.ranking import (
    MAX_CANDIDATE_CHUNKS,
    MIN_CANDIDATE_CHUNKS,
    ResourceChunkCandidate,
    Rag2ResourceSearchError,
    aggregate_resource_candidates,
    candidate_chunk_limit,
    resource_relevance_score,
    search_server_resources,
)
from rag2.ratings import (
    Rag2RatingError,
    delete_resource_rating,
    set_resource_rating,
)
from rag2.schemas import Rag2ResourceSearchResult


MIGRATION_PATH = (
    BACKEND_DIR
    / "migrations"
    / "20260730_phase18_4_rag2_resource_ranking_ratings.sql"
)
PRIOR_MIGRATION_HASHES = {
    "20260730_phase18_1b_rag2_resource_foundation.sql":
        "7ABB79CD22321E791F24D3D82EEB9527099C9D4F095B445003799DE11B4FD206",
    "20260730_phase18_2_rag2_resource_indexing.sql":
        "2ABA3099825DCC223A6EF17FB012549E6CFC98EDD40EA61921E4EAB35F67CCC9",
    "20260730_phase18_3_rag2_hnsw_retrieval.sql":
        "78D37F7F94D4A4C720A72AFE8C0B7B156E7A213F4A73D1077A7AABF731CDEEEB",
}


def candidate_row(
    server_id,
    resource_id=None,
    *,
    chunk_index=0,
    similarity=0.8,
    content="Relevant semantic evidence.",
    rating=3.0,
    rating_count=1,
    current_rating=3,
    title="Resource",
):
    return {
        "server_id": server_id,
        "resource_id": resource_id or str(uuid.uuid4()),
        "chunk_id": str(uuid.uuid4()),
        "chunk_index": chunk_index,
        "content": content,
        "cosine_distance": 1 - similarity,
        "cosine_similarity": similarity,
        "title": title,
        "original_filename": "resource.pdf",
        "detected_type": "pdf",
        "size_bytes": 1234,
        "indexed_at": datetime.now(timezone.utc).isoformat(),
        "average_rating": rating,
        "rating_count": rating_count,
        "current_user_rating": current_rating,
        "embedding": [1.0, 0.0],
        "storage_path": "must/not/leak.pdf",
        "uploader_id": str(uuid.uuid4()),
        "content_sha256": "must-not-leak",
    }


def candidate_model(**overrides):
    server_id = overrides.pop("server_id", str(uuid.uuid4()))
    return ResourceChunkCandidate.model_validate(
        candidate_row(server_id, **overrides)
    )


class FakeEmbeddings:
    def __init__(self, error=None):
        self.error = error
        self.calls = []

    async def aembed_query(self, query, **kwargs):
        self.calls.append((query, kwargs))
        if self.error:
            raise self.error
        return [1.0] + [0.0] * 767


class FakeRpcClient:
    def __init__(self, rows=None, error=None, role="member"):
        self.rows = rows if rows is not None else []
        self.error = error
        self.role = role
        self.calls = []

    async def rpc(self, function_name, payload):
        self.calls.append(("rpc", function_name, payload))
        if self.error:
            raise self.error
        return self.rows

    async def rest(
        self,
        method,
        path,
        *,
        params=None,
        json_body=None,
        prefer=None,
    ):
        self.calls.append(("rest", path, params))
        if path == "server_members":
            return [{"role": self.role}] if self.role else []
        raise AssertionError(path)


class Rag2Phase184MigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = MIGRATION_PATH.read_text(encoding="utf-8").lower()

    def test_rating_schema_constraints_and_cascades(self):
        self.assertIn("create table public.resource_ratings", self.sql)
        self.assertIn("primary key (resource_id, user_id)", self.sql)
        self.assertIn("foreign key (resource_id, server_id)", self.sql)
        self.assertIn(
            "references public.server_resources(id, server_id)",
            self.sql,
        )
        self.assertGreaterEqual(self.sql.count("on delete cascade"), 2)
        self.assertIn("references public.profiles(id)", self.sql)
        self.assertIn("check (rating between 1 and 5)", self.sql)
        self.assertIn("set_resource_ratings_updated_at", self.sql)

    def test_rating_rls_ownership_membership_visibility_and_least_privilege(self):
        self.assertIn("alter table public.resource_ratings enable row level security", self.sql)
        for operation in ("select", "insert", "update", "delete"):
            self.assertIn(f"resource_ratings_{operation}", self.sql)
        self.assertIn("user_id = auth.uid()", self.sql)
        self.assertIn("public.is_server_member(server_id, auth.uid())", self.sql)
        self.assertIn("resource.visibility = 'server'", self.sql)
        self.assertIn(
            "revoke all on table public.resource_ratings from public, anon, authenticated",
            self.sql,
        )
        self.assertNotIn("grant insert on table public.resource_ratings", self.sql)
        self.assertNotIn("grant update on table public.resource_ratings", self.sql)

    def test_rating_rpcs_are_atomic_scoped_and_idempotent(self):
        self.assertIn("set_server_resource_rating", self.sql)
        self.assertIn("delete_server_resource_rating", self.sql)
        self.assertIn(
            "on conflict on constraint resource_ratings_pkey",
            self.sql,
        )
        self.assertIn("do update", self.sql)
        self.assertIn("stored.user_id = v_actor_id", self.sql)
        self.assertIn("v_resource.visibility <> 'server'", self.sql)
        self.assertIn(
            "public.is_server_member(v_resource.server_id, v_actor_id)",
            self.sql,
        )
        self.assertIn("security definer", self.sql)
        self.assertIn("set search_path = ''", self.sql)
        self.assertIn("to authenticated", self.sql)
        self.assertIn("from public, anon", self.sql)

    def test_candidate_rpc_preserves_hnsw_scope_and_enriches_after_limit(self):
        self.assertIn("match_server_resource_chunk_candidates", self.sql)
        self.assertIn("p_candidate_limit not between 1 and 100", self.sql)
        self.assertIn("with candidates as materialized", self.sql)
        self.assertIn("limit p_candidate_limit", self.sql)
        self.assertIn("rating_summaries as materialized", self.sql)
        self.assertLess(
            self.sql.index("limit p_candidate_limit"),
            self.sql.index("rating_summaries as materialized"),
        )
        self.assertIn("'hnsw.iterative_scan'", self.sql)
        self.assertIn("'strict_order'", self.sql)
        self.assertIn("operator(extensions.<=>)", self.sql)
        self.assertIn("resource.index_status = 'ready'", self.sql)
        self.assertIn("resource.visibility = 'server'", self.sql)
        self.assertIn("resource.embedding_dimensions = 768", self.sql)
        self.assertIn("models/gemini-embedding-001", self.sql)
        self.assertNotIn("order by average_rating", self.sql)

    def test_historical_ratings_are_not_membership_filtered_from_aggregate(self):
        aggregate = self.sql[
            self.sql.index("rating_summaries as materialized"):
            self.sql.index("select\n    candidate.server_id")
        ]
        self.assertIn("from public.resource_ratings as stored", aggregate)
        self.assertNotIn("server_members", aggregate)
        self.assertNotIn("is_server_member", aggregate)

    def test_executed_phase_migration_fingerprints_are_unchanged(self):
        migration_dir = BACKEND_DIR / "migrations"
        for filename, expected in PRIOR_MIGRATION_HASHES.items():
            digest = hashlib.sha256((migration_dir / filename).read_bytes()).hexdigest()
            self.assertEqual(digest.upper(), expected)


class Rag2ResourceRankingTests(unittest.TestCase):
    def test_candidate_limit_is_bounded(self):
        self.assertEqual(candidate_chunk_limit(1), MIN_CANDIDATE_CHUNKS)
        self.assertEqual(candidate_chunk_limit(5), 40)
        self.assertEqual(candidate_chunk_limit(10), 80)
        self.assertEqual(candidate_chunk_limit(25), MAX_CANDIDATE_CHUNKS)
        for invalid in (0, 26):
            with self.assertRaises(ValueError):
                candidate_chunk_limit(invalid)

    def test_missing_support_does_not_penalize(self):
        item = candidate_model(similarity=0.82)
        self.assertAlmostEqual(resource_relevance_score([item]), 0.82)

    def test_diverse_support_is_bounded(self):
        resource_id = str(uuid.uuid4())
        items = [
            candidate_model(resource_id=resource_id, chunk_index=0, similarity=0.8),
            candidate_model(
                resource_id=resource_id,
                chunk_index=2,
                similarity=0.7,
                content="Second supporting passage.",
            ),
            candidate_model(
                resource_id=resource_id,
                chunk_index=4,
                similarity=0.6,
                content="Third supporting passage.",
            ),
        ]
        score = resource_relevance_score(items)
        self.assertAlmostEqual(score, 0.827)
        self.assertGreater(score, 0.8)
        self.assertLessEqual(score, 1.0)

    def test_adjacent_and_duplicate_chunks_do_not_support(self):
        resource_id = str(uuid.uuid4())
        strongest = candidate_model(
            resource_id=resource_id,
            chunk_index=0,
            similarity=0.8,
            content="Repeated evidence.",
        )
        adjacent = candidate_model(
            resource_id=resource_id,
            chunk_index=1,
            similarity=0.79,
            content="Adjacent overlap.",
        )
        duplicate = candidate_model(
            resource_id=resource_id,
            chunk_index=3,
            similarity=0.78,
            content="  repeated   evidence. ",
        )
        self.assertAlmostEqual(
            resource_relevance_score([strongest, adjacent, duplicate]),
            0.8,
        )

    def test_more_chunks_and_long_documents_do_not_dominate(self):
        long_id = str(uuid.uuid4())
        many = [
            candidate_model(
                resource_id=long_id,
                chunk_index=index * 2,
                similarity=0.8 - index * 0.001,
                content=f"Distinct passage {index}",
            )
            for index in range(20)
        ]
        three = many[:3]
        self.assertAlmostEqual(
            resource_relevance_score(many),
            resource_relevance_score(three),
        )
        self.assertLess(resource_relevance_score(many), 0.9)

    def test_groups_unique_resources_and_resource_limit_applies(self):
        server_id = str(uuid.uuid4())
        first_id = str(uuid.uuid4())
        second_id = str(uuid.uuid4())
        rows = [
            candidate_row(server_id, first_id, similarity=0.9),
            candidate_row(
                server_id,
                first_id,
                chunk_index=2,
                similarity=0.8,
                content="Support",
            ),
            candidate_row(server_id, second_id, similarity=0.7),
        ]
        results = aggregate_resource_candidates(rows, server_id, limit=1)
        self.assertEqual(len(results), 1)
        self.assertEqual(str(results[0].resource_id), first_id)
        self.assertEqual(results[0].matched_candidate_chunk_count, 2)

    def test_rating_does_not_influence_semantic_order(self):
        server_id = str(uuid.uuid4())
        relevant_id = str(uuid.uuid4())
        rated_id = str(uuid.uuid4())
        rows = [
            candidate_row(
                server_id,
                relevant_id,
                similarity=0.9,
                rating=1.0,
                current_rating=1,
            ),
            candidate_row(
                server_id,
                rated_id,
                similarity=0.7,
                rating=5.0,
                current_rating=5,
            ),
        ]
        results = aggregate_resource_candidates(rows, server_id, limit=2)
        self.assertEqual(str(results[0].resource_id), relevant_id)

    def test_deterministic_resource_uuid_tie_order(self):
        server_id = str(uuid.uuid4())
        low_id = "00000000-0000-0000-0000-000000000001"
        high_id = "00000000-0000-0000-0000-000000000002"
        rows = [
            candidate_row(server_id, high_id, similarity=0.8),
            candidate_row(server_id, low_id, similarity=0.8),
        ]
        results = aggregate_resource_candidates(rows, server_id, limit=2)
        self.assertEqual(
            [str(result.resource_id) for result in results],
            [low_id, high_id],
        )

    def test_snippet_is_normalized_capped_and_response_is_safe(self):
        server_id = str(uuid.uuid4())
        row = candidate_row(
            server_id,
            content=("word \n\t" * 200),
        )
        result = aggregate_resource_candidates([row], server_id, limit=1)[0]
        self.assertLessEqual(len(result.best_match.snippet), 600)
        self.assertTrue(result.best_match.snippet.endswith("…"))
        payload = result.model_dump(mode="json")
        self.assertEqual(
            set(payload),
            {
                "server_id",
                "resource_id",
                "title",
                "original_filename",
                "detected_type",
                "size_bytes",
                "indexed_at",
                "relevance_score",
                "best_chunk_similarity",
                "best_match",
                "matched_candidate_chunk_count",
                "average_rating",
                "rating_count",
                "current_user_rating",
            },
        )

    def test_cross_server_private_nonready_are_database_filtered_and_leaks_rejected(self):
        sql = MIGRATION_PATH.read_text(encoding="utf-8").lower()
        self.assertIn("chunk.server_id = p_server_id", sql)
        self.assertIn("resource.server_id = p_server_id", sql)
        self.assertIn("resource.visibility = 'server'", sql)
        self.assertIn("resource.index_status = 'ready'", sql)
        with self.assertRaises(Rag2ResourceSearchError):
            aggregate_resource_candidates(
                [candidate_row(str(uuid.uuid4()))],
                str(uuid.uuid4()),
                limit=1,
            )


class Rag2ResourceSearchServiceTests(unittest.TestCase):
    def test_query_embedding_and_candidate_rpc_are_caller_scoped(self):
        server_id = str(uuid.uuid4())
        resource_id = str(uuid.uuid4())
        client = FakeRpcClient(
            rows=[candidate_row(server_id, resource_id, rating=None, rating_count=0, current_rating=None)]
        )
        embeddings = FakeEmbeddings()
        results = asyncio.run(
            search_server_resources(
                client,
                server_id,
                "  HNSW search  ",
                limit=5,
                embeddings=embeddings,
            )
        )
        self.assertEqual(len(results), 1)
        query, kwargs = embeddings.calls[0]
        self.assertEqual(query, "HNSW search")
        self.assertEqual(kwargs["task_type"], "RETRIEVAL_QUERY")
        _, function_name, payload = client.calls[0]
        self.assertEqual(function_name, "match_server_resource_chunk_candidates")
        self.assertEqual(payload["p_candidate_limit"], 40)
        self.assertEqual(len(payload["p_query_embedding"]), 768)

    def test_empty_provider_and_database_failures(self):
        server_id = str(uuid.uuid4())
        empty = asyncio.run(
            search_server_resources(
                FakeRpcClient(),
                server_id,
                "query",
                embeddings=FakeEmbeddings(),
            )
        )
        self.assertEqual(empty, [])

        with self.assertRaises(Rag2ResourceSearchError) as provider:
            asyncio.run(
                search_server_resources(
                    FakeRpcClient(),
                    server_id,
                    "query",
                    embeddings=FakeEmbeddings(RuntimeError("provider")),
                )
            )
        self.assertEqual(provider.exception.status_code, 502)

        with self.assertRaises(Rag2ResourceSearchError) as database:
            asyncio.run(
                search_server_resources(
                    FakeRpcClient(error=RuntimeError("database")),
                    server_id,
                    "query",
                    embeddings=FakeEmbeddings(),
                )
            )
        self.assertEqual(database.exception.status_code, 500)


class Rag2RatingServiceTests(unittest.TestCase):
    def setUp(self):
        self.resource_id = str(uuid.uuid4())

    def test_set_and_update_use_atomic_rpc_and_validate_range(self):
        rows = [{
            "resource_id": self.resource_id,
            "average_rating": 4.0,
            "rating_count": 2,
            "current_user_rating": 5,
        }]
        client = FakeRpcClient(rows=rows)
        summary = asyncio.run(
            set_resource_rating(client, self.resource_id, 5)
        )
        self.assertEqual(summary.current_user_rating, 5)
        self.assertEqual(
            client.calls[0][1],
            "set_server_resource_rating",
        )
        for invalid in (0, 6, True):
            with self.assertRaises(Rag2RatingError) as raised:
                asyncio.run(
                    set_resource_rating(client, self.resource_id, invalid)
                )
            self.assertEqual(raised.exception.status_code, 422)

    def test_delete_is_idempotent_and_returns_empty_summary(self):
        client = FakeRpcClient(rows=[{
            "resource_id": self.resource_id,
            "average_rating": None,
            "rating_count": 0,
            "current_user_rating": None,
        }])
        summary = asyncio.run(
            delete_resource_rating(client, self.resource_id)
        )
        self.assertEqual(summary.rating_count, 0)
        self.assertIsNone(summary.current_user_rating)
        self.assertEqual(
            client.calls[0][1],
            "delete_server_resource_rating",
        )

    def test_access_and_database_failures_are_safe(self):
        for source_status, expected in ((403, 403), (404, 404), (500, 500)):
            client = FakeRpcClient(
                error=HTTPException(source_status, "database detail")
            )
            with self.assertRaises(Rag2RatingError) as raised:
                asyncio.run(
                    set_resource_rating(client, self.resource_id, 4)
                )
            self.assertEqual(raised.exception.status_code, expected)


class Rag2Phase184EndpointTests(unittest.TestCase):
    def setUp(self):
        self.user_id = str(uuid.uuid4())
        self.server_id = str(uuid.uuid4())
        self.resource_id = str(uuid.uuid4())

    def tearDown(self):
        main.app.dependency_overrides.clear()

    def authenticate(self, client):
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": self.user_id,
            "email": None,
            "supabase_user": client,
        }

    def test_resource_search_authorizes_before_embedding_service(self):
        nonmember = FakeRpcClient(role=None)
        self.authenticate(nonmember)
        with (
            patch("main.search_server_resources", new=AsyncMock()) as search,
            TestClient(main.app) as api,
        ):
            denied = api.post(
                f"/api/rag2/servers/{self.server_id}/resources/search",
                json={"query": "HNSW", "limit": 5},
            )
        self.assertEqual(denied.status_code, 403)
        search.assert_not_awaited()

        member = FakeRpcClient(role="member")
        self.authenticate(member)
        with (
            patch(
                "main.search_server_resources",
                new=AsyncMock(return_value=[]),
            ) as search,
            patch("main.supabase_admin") as admin,
            TestClient(main.app) as api,
        ):
            response = api.post(
                f"/api/rag2/servers/{self.server_id}/resources/search",
                json={"query": "  HNSW  ", "limit": 5},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["results"], [])
        search.assert_awaited_once_with(
            member,
            self.server_id,
            "HNSW",
            limit=5,
        )
        admin.assert_not_called()

    def test_resource_search_request_validation_and_authentication(self):
        with TestClient(main.app) as api:
            unauthenticated = api.post(
                f"/api/rag2/servers/{self.server_id}/resources/search",
                json={"query": "valid"},
            )
        self.assertEqual(unauthenticated.status_code, 401)

        self.authenticate(FakeRpcClient())
        cases = (
            (f"/api/rag2/servers/{self.server_id}/resources/search", {"query": " "}),
            (f"/api/rag2/servers/{self.server_id}/resources/search", {"query": "x" * 1001}),
            (f"/api/rag2/servers/{self.server_id}/resources/search", {"query": "x", "limit": 0}),
            (f"/api/rag2/servers/{self.server_id}/resources/search", {"query": "x", "limit": 26}),
            ("/api/rag2/servers/not-a-uuid/resources/search", {"query": "x"}),
        )
        with TestClient(main.app) as api:
            for path, body in cases:
                with self.subTest(path=path):
                    self.assertEqual(api.post(path, json=body).status_code, 422)

    def test_rating_endpoints_use_caller_rpc_and_never_service_role(self):
        client = FakeRpcClient(rows=[{
            "resource_id": self.resource_id,
            "average_rating": 4.0,
            "rating_count": 1,
            "current_user_rating": 4,
        }])
        self.authenticate(client)
        with patch("main.supabase_admin") as admin, TestClient(main.app) as api:
            put = api.put(
                f"/api/rag2/resources/{self.resource_id}/rating",
                json={"rating": 4},
            )
        self.assertEqual(put.status_code, 200, put.text)
        self.assertEqual(client.calls[0][1], "set_server_resource_rating")
        admin.assert_not_called()

        client.rows = [{
            "resource_id": self.resource_id,
            "average_rating": None,
            "rating_count": 0,
            "current_user_rating": None,
        }]
        client.calls.clear()
        with TestClient(main.app) as api:
            delete = api.delete(
                f"/api/rag2/resources/{self.resource_id}/rating"
            )
        self.assertEqual(delete.status_code, 200, delete.text)
        self.assertIsNone(delete.json()["current_user_rating"])
        self.assertEqual(client.calls[0][1], "delete_server_resource_rating")

    def test_rating_request_uuid_auth_and_bounds(self):
        with TestClient(main.app) as api:
            unauthenticated = api.put(
                f"/api/rag2/resources/{self.resource_id}/rating",
                json={"rating": 4},
            )
        self.assertEqual(unauthenticated.status_code, 401)

        self.authenticate(FakeRpcClient())
        with TestClient(main.app) as api:
            for rating in (0, 6, True, 4.5, "4"):
                response = api.put(
                    f"/api/rag2/resources/{self.resource_id}/rating",
                    json={"rating": rating},
                )
                self.assertEqual(response.status_code, 422)
            self.assertEqual(
                api.put(
                    "/api/rag2/resources/not-a-uuid/rating",
                    json={"rating": 4},
                ).status_code,
                422,
            )


if __name__ == "__main__":
    unittest.main()
