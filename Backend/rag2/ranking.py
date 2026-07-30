"""Explainable resource-level aggregation over bounded RAG 2 chunk candidates."""

import math
import re
from collections import defaultdict
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .embeddings import Rag2EmbeddingError, embed_search_query
from .schemas import (
    Rag2BestMatch,
    Rag2ResourceSearchResult,
)


MIN_CANDIDATE_CHUNKS = 25
MAX_CANDIDATE_CHUNKS = 100
CANDIDATE_MULTIPLIER = 8
MAX_EVIDENCE_CHUNKS = 3
SECONDARY_EVIDENCE_WEIGHT = 0.15
TERTIARY_EVIDENCE_WEIGHT = 0.05
MAX_SNIPPET_CHARS = 600


class CallerScopedRankingClient(Protocol):
    async def rpc(self, function_name: str, payload: dict[str, Any]) -> Any: ...


class Rag2ResourceSearchError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class ResourceChunkCandidate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    server_id: UUID
    resource_id: UUID
    chunk_id: UUID
    chunk_index: int = Field(ge=0)
    content: str = Field(min_length=1)
    cosine_distance: float
    cosine_similarity: float
    title: str = Field(min_length=1)
    original_filename: str = Field(min_length=1)
    detected_type: str
    size_bytes: int | None = Field(default=None, gt=0)
    indexed_at: datetime
    average_rating: float | None = Field(default=None, ge=1, le=5)
    rating_count: int = Field(ge=0)
    current_user_rating: int | None = Field(default=None, ge=1, le=5)


def candidate_chunk_limit(resource_limit: int) -> int:
    if resource_limit < 1 or resource_limit > 25:
        raise ValueError("resource limit must be between 1 and 25")
    return min(
        MAX_CANDIDATE_CHUNKS,
        max(MIN_CANDIDATE_CHUNKS, resource_limit * CANDIDATE_MULTIPLIER),
    )


def _clamp_similarity(value: float) -> float:
    return min(1.0, max(0.0, value))


def _normalized_content(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def _snippet(value: str) -> str:
    normalized = re.sub(r"\s+", " ", value).strip()
    if len(normalized) <= MAX_SNIPPET_CHARS:
        return normalized
    return normalized[: MAX_SNIPPET_CHARS - 1].rstrip() + "…"


def _selected_evidence(
    candidates: list[ResourceChunkCandidate],
) -> list[ResourceChunkCandidate]:
    ordered = sorted(
        candidates,
        key=lambda item: (
            -item.cosine_similarity,
            item.chunk_index,
            str(item.chunk_id),
        ),
    )
    selected: list[ResourceChunkCandidate] = []
    seen_content: set[str] = set()
    for candidate in ordered:
        normalized = _normalized_content(candidate.content)
        if normalized in seen_content:
            continue
        if selected and any(
            abs(candidate.chunk_index - evidence.chunk_index) <= 1
            for evidence in selected
        ):
            continue
        selected.append(candidate)
        seen_content.add(normalized)
        if len(selected) == MAX_EVIDENCE_CHUNKS:
            break
    return selected


def resource_relevance_score(
    candidates: list[ResourceChunkCandidate],
) -> float:
    if not candidates:
        raise ValueError("at least one candidate is required")
    evidence = _selected_evidence(candidates)
    strongest = _clamp_similarity(evidence[0].cosine_similarity)
    second = (
        _clamp_similarity(evidence[1].cosine_similarity)
        if len(evidence) > 1
        else 0.0
    )
    third = (
        _clamp_similarity(evidence[2].cosine_similarity)
        if len(evidence) > 2
        else 0.0
    )
    score = strongest + (1.0 - strongest) * (
        SECONDARY_EVIDENCE_WEIGHT * second
        + TERTIARY_EVIDENCE_WEIGHT * third
    )
    return min(1.0, max(0.0, score))


def aggregate_resource_candidates(
    rows: list[dict[str, Any]],
    server_id: str,
    *,
    limit: int,
) -> list[Rag2ResourceSearchResult]:
    grouped: dict[UUID, list[ResourceChunkCandidate]] = defaultdict(list)
    for row in rows:
        try:
            candidate = ResourceChunkCandidate.model_validate(row)
        except Exception as error:
            raise Rag2ResourceSearchError(
                500,
                "Resource retrieval returned an invalid candidate.",
            ) from error
        if str(candidate.server_id) != server_id:
            raise Rag2ResourceSearchError(
                500,
                "Resource retrieval returned an invalid server scope.",
            )
        if (
            not math.isfinite(candidate.cosine_distance)
            or not math.isfinite(candidate.cosine_similarity)
            or candidate.cosine_similarity < -1.000001
            or candidate.cosine_similarity > 1.000001
        ):
            raise Rag2ResourceSearchError(
                500,
                "Resource retrieval returned invalid cosine values.",
            )
        if (
            (candidate.rating_count == 0 and candidate.average_rating is not None)
            or (candidate.rating_count > 0 and candidate.average_rating is None)
            or (
                candidate.current_user_rating is not None
                and candidate.rating_count == 0
            )
        ):
            raise Rag2ResourceSearchError(
                500,
                "Resource retrieval returned an invalid rating summary.",
            )
        grouped[candidate.resource_id].append(candidate)

    results: list[Rag2ResourceSearchResult] = []
    for resource_id, candidates in grouped.items():
        first = candidates[0]
        metadata = (
            first.server_id,
            first.title,
            first.original_filename,
            first.detected_type,
            first.size_bytes,
            first.indexed_at,
            first.average_rating,
            first.rating_count,
            first.current_user_rating,
        )
        if any(
            (
                candidate.server_id,
                candidate.title,
                candidate.original_filename,
                candidate.detected_type,
                candidate.size_bytes,
                candidate.indexed_at,
                candidate.average_rating,
                candidate.rating_count,
                candidate.current_user_rating,
            )
            != metadata
            for candidate in candidates[1:]
        ):
            raise Rag2ResourceSearchError(
                500,
                "Resource retrieval returned inconsistent metadata.",
            )
        best = max(
            candidates,
            key=lambda item: (
                item.cosine_similarity,
                -item.chunk_index,
                str(item.chunk_id),
            ),
        )
        results.append(
            Rag2ResourceSearchResult(
                server_id=first.server_id,
                resource_id=resource_id,
                title=first.title,
                original_filename=first.original_filename,
                detected_type=first.detected_type,
                size_bytes=first.size_bytes,
                indexed_at=first.indexed_at,
                relevance_score=resource_relevance_score(candidates),
                best_chunk_similarity=min(
                    1.0,
                    max(-1.0, best.cosine_similarity),
                ),
                best_match=Rag2BestMatch(
                    chunk_index=best.chunk_index,
                    snippet=_snippet(best.content),
                ),
                matched_candidate_chunk_count=len(candidates),
                average_rating=first.average_rating,
                rating_count=first.rating_count,
                current_user_rating=first.current_user_rating,
            )
        )

    results.sort(
        key=lambda item: (
            -item.relevance_score,
            -item.best_chunk_similarity,
            str(item.resource_id),
        )
    )
    return results[:limit]


async def search_server_resources(
    client: CallerScopedRankingClient,
    server_id: str,
    query: str,
    *,
    limit: int = 5,
    embeddings=None,
) -> list[Rag2ResourceSearchResult]:
    normalized_query = query.strip()
    if not normalized_query or len(normalized_query) > 1000:
        raise Rag2ResourceSearchError(
            422,
            "Search query must contain 1 to 1000 characters.",
        )
    try:
        bounded_candidate_limit = candidate_chunk_limit(limit)
    except ValueError as error:
        raise Rag2ResourceSearchError(
            422,
            "Resource search limit must be between 1 and 25.",
        ) from error

    try:
        query_embedding = await embed_search_query(
            normalized_query,
            embeddings=embeddings,
        )
    except Rag2EmbeddingError as error:
        raise Rag2ResourceSearchError(
            502,
            "Search query embedding could not be generated.",
        ) from error

    try:
        rows = await client.rpc(
            "match_server_resource_chunk_candidates",
            {
                "p_server_id": server_id,
                "p_query_embedding": query_embedding,
                "p_candidate_limit": bounded_candidate_limit,
            },
        )
    except Exception as error:
        if getattr(error, "status_code", None) == 403:
            raise Rag2ResourceSearchError(
                403,
                "Current server membership is required.",
            ) from error
        raise Rag2ResourceSearchError(
            500,
            "Resource retrieval could not be completed.",
        ) from error

    return aggregate_resource_candidates(rows or [], server_id, limit=limit)
