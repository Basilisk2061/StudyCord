"""Server-scoped RAG 2 resource foundation and indexing."""

from .automatic_ingestion import (
    Rag2AutomaticIngestionError,
    register_attachment_for_rag2,
)
from .access import (
    Rag2ResourceAccessError,
    download_resource_for_access,
    resolve_resource_for_access,
    validate_resource_for_access,
)
from .embeddings import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, embed_search_query
from .indexing import (
    Rag2IndexingError,
    has_safe_canonical_storage_path,
    index_authorized_resource,
    resolve_authorized_resource,
)
from .resources import list_server_resources
from .ranking import (
    Rag2ResourceSearchError,
    candidate_chunk_limit,
    search_server_resources,
)
from .ratings import (
    Rag2RatingError,
    delete_resource_rating,
    set_resource_rating,
)
from .schemas import (
    Rag2ChunkHit,
    Rag2AutomaticIngestionResponse,
    Rag2IndexingResponse,
    Rag2RatingRequest,
    Rag2RatingSummary,
    Rag2ResourceSearchRequest,
    Rag2ResourceSearchResponse,
    Rag2SearchRequest,
    Rag2SearchResponse,
    ServerResourceSummary,
)
from .search import Rag2SearchError, search_server_chunks

__all__ = [
    "EMBEDDING_DIMENSIONS",
    "EMBEDDING_MODEL",
    "Rag2AutomaticIngestionError",
    "Rag2AutomaticIngestionResponse",
    "Rag2ResourceAccessError",
    "Rag2IndexingError",
    "Rag2IndexingResponse",
    "Rag2ChunkHit",
    "Rag2RatingError",
    "Rag2RatingRequest",
    "Rag2RatingSummary",
    "Rag2ResourceSearchError",
    "Rag2ResourceSearchRequest",
    "Rag2ResourceSearchResponse",
    "Rag2SearchError",
    "Rag2SearchRequest",
    "Rag2SearchResponse",
    "ServerResourceSummary",
    "embed_search_query",
    "candidate_chunk_limit",
    "delete_resource_rating",
    "download_resource_for_access",
    "has_safe_canonical_storage_path",
    "index_authorized_resource",
    "list_server_resources",
    "register_attachment_for_rag2",
    "resolve_authorized_resource",
    "resolve_resource_for_access",
    "search_server_resources",
    "search_server_chunks",
    "set_resource_rating",
    "validate_resource_for_access",
]
