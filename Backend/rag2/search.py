"""Caller-scoped server semantic chunk retrieval for RAG 2."""

import math
from typing import Any, Protocol

from .embeddings import Rag2EmbeddingError, embed_search_query
from .schemas import Rag2ChunkHit


class CallerScopedSearchClient(Protocol):
    async def rpc(self, function_name: str, payload: dict[str, Any]) -> Any: ...


class Rag2SearchError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


async def search_server_chunks(
    client: CallerScopedSearchClient,
    server_id: str,
    query: str,
    *,
    limit: int = 10,
    embeddings=None,
) -> list[Rag2ChunkHit]:
    """Embed a query and invoke the membership-enforcing RPC with caller JWT."""
    normalized_query = query.strip()
    if not normalized_query or len(normalized_query) > 1000:
        raise Rag2SearchError(422, "Search query must contain 1 to 1000 characters.")
    if limit < 1 or limit > 25:
        raise Rag2SearchError(422, "Search limit must be between 1 and 25.")

    try:
        query_embedding = await embed_search_query(
            normalized_query,
            embeddings=embeddings,
        )
    except Rag2EmbeddingError as error:
        raise Rag2SearchError(
            502,
            "Search query embedding could not be generated.",
        ) from error

    try:
        rows = await client.rpc(
            "match_server_resource_chunks",
            {
                "p_server_id": server_id,
                "p_query_embedding": query_embedding,
                "p_limit": limit,
            },
        )
    except Exception as error:
        if getattr(error, "status_code", None) == 403:
            raise Rag2SearchError(
                403,
                "Current server membership is required.",
            ) from error
        raise Rag2SearchError(
            500,
            "Semantic retrieval could not be completed.",
        ) from error

    results: list[Rag2ChunkHit] = []
    previous_distance = -math.inf
    for row in rows or []:
        try:
            hit = Rag2ChunkHit.model_validate(row)
        except Exception as error:
            raise Rag2SearchError(
                500,
                "Semantic retrieval returned an invalid result.",
            ) from error
        if str(hit.server_id) != server_id:
            raise Rag2SearchError(
                500,
                "Semantic retrieval returned an invalid server scope.",
            )
        if (
            not math.isfinite(hit.cosine_distance)
            or not math.isfinite(hit.cosine_similarity)
            or hit.cosine_distance + 1e-12 < previous_distance
        ):
            raise Rag2SearchError(
                500,
                "Semantic retrieval returned invalid cosine ordering.",
            )
        previous_distance = hit.cosine_distance
        results.append(hit)
    return results
