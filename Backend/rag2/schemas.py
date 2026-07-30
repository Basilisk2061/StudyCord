"""Safe API schemas for canonical server resources."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


ResourceVisibility = Literal["server", "private"]
ResourceIndexStatus = Literal[
    "unindexed",
    "pending",
    "processing",
    "ready",
    "failed",
    "unsupported",
]


class ServerResourceSummary(BaseModel):
    """Canonical metadata safe to return to an authorized server member."""

    model_config = ConfigDict(extra="ignore")

    id: UUID
    server_id: UUID
    title: str
    original_filename: str
    declared_mime_type: str | None = None
    detected_type: Literal["pdf", "docx", "txt"] | None = None
    size_bytes: int | None = None
    visibility: ResourceVisibility
    index_status: ResourceIndexStatus
    created_at: datetime
    updated_at: datetime


class Rag2IndexingResponse(BaseModel):
    resource_id: UUID
    server_id: UUID
    detected_type: Literal["pdf", "docx", "txt"]
    index_status: Literal["ready"] = "ready"
    chunk_count: int
    embedding_model: str
    embedding_dimensions: Literal[768] = 768
    indexed_at: datetime


class Rag2AutomaticIngestionResponse(BaseModel):
    resource_id: UUID
    indexing_scheduled: bool


class ChannelResourceMetadataRequest(BaseModel):
    resource_ids: list[UUID] = Field(min_length=1, max_length=200)


class ChannelResourceCardMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore")

    resource_id: UUID
    title: str
    original_filename: str
    detected_type: Literal["pdf", "docx", "txt"]
    size_bytes: int | None = None
    average_rating: float | None = Field(default=None, ge=1, le=5)
    rating_count: int = Field(ge=0)
    current_user_rating: int | None = Field(default=None, ge=1, le=5)


class Rag2SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    limit: int = Field(default=10, ge=1, le=25)

    @field_validator("query", mode="before")
    @classmethod
    def normalize_query(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class Rag2ChunkHit(BaseModel):
    model_config = ConfigDict(extra="ignore")

    server_id: UUID
    resource_id: UUID
    chunk_id: UUID
    chunk_index: int = Field(ge=0)
    content: str = Field(min_length=1)
    cosine_distance: float
    cosine_similarity: float


class Rag2SearchResponse(BaseModel):
    server_id: UUID
    query: str
    results: list[Rag2ChunkHit]


class Rag2ResourceSearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    limit: int = Field(default=5, ge=1, le=25)

    @field_validator("query", mode="before")
    @classmethod
    def normalize_query(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value


class Rag2BestMatch(BaseModel):
    chunk_index: int = Field(ge=0)
    snippet: str = Field(min_length=1, max_length=600)


class Rag2ResourceSearchResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    server_id: UUID
    resource_id: UUID
    title: str
    original_filename: str
    detected_type: Literal["pdf", "docx", "txt"]
    size_bytes: int | None = None
    indexed_at: datetime
    relevance_score: float = Field(ge=0, le=1)
    best_chunk_similarity: float = Field(ge=-1, le=1)
    best_match: Rag2BestMatch
    matched_candidate_chunk_count: int = Field(ge=1, le=100)
    average_rating: float | None = Field(default=None, ge=1, le=5)
    rating_count: int = Field(ge=0)
    current_user_rating: int | None = Field(default=None, ge=1, le=5)


class Rag2ResourceSearchResponse(BaseModel):
    server_id: UUID
    query: str
    results: list[Rag2ResourceSearchResult]


class Rag2RatingRequest(BaseModel):
    rating: int = Field(strict=True, ge=1, le=5)


class Rag2RatingSummary(BaseModel):
    model_config = ConfigDict(extra="ignore")

    resource_id: UUID
    average_rating: float | None = Field(default=None, ge=1, le=5)
    rating_count: int = Field(ge=0)
    current_user_rating: int | None = Field(default=None, ge=1, le=5)
