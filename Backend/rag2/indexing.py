"""Backend-controlled RAG 2 indexing orchestration."""

import hashlib
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from .document_processing import Rag2DocumentError, process_resource_document
from .embeddings import (
    EMBEDDING_BATCH_SIZE,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    Rag2EmbeddingError,
    embed_document_chunks,
)


class TrustedIndexingClient(Protocol):
    async def rpc(self, function_name: str, payload: dict[str, Any]) -> Any: ...

    async def storage_download(
        self,
        bucket: str,
        path: str,
        *,
        max_bytes: int,
    ) -> bytes: ...


@dataclass(frozen=True)
class AuthorizedResource:
    id: str
    server_id: str
    uploader_id: str
    original_filename: str
    storage_bucket: str
    storage_path: str
    visibility: str
    index_status: str
    index_started_at: str | None


@dataclass(frozen=True)
class IndexingResult:
    resource_id: str
    server_id: str
    detected_type: str
    chunk_count: int
    indexed_at: datetime


class Rag2IndexingError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def has_safe_canonical_storage_path(path: str) -> bool:
    if not path or len(path) > 1024 or "\\" in path or path.startswith("/"):
        return False
    segments = path.split("/")
    return all(segment not in {"", ".", ".."} for segment in segments)


def _canonical_resource(row: dict[str, Any]) -> AuthorizedResource:
    required = (
        "id",
        "server_id",
        "uploader_id",
        "original_filename",
        "storage_bucket",
        "storage_path",
        "visibility",
        "index_status",
    )
    if any(not row.get(field) for field in required):
        raise Rag2IndexingError(409, "The resource metadata is incomplete.")
    values = {field: str(row[field]) for field in required}
    values["index_started_at"] = (
        str(row["index_started_at"])
        if row.get("index_started_at") is not None
        else None
    )
    return AuthorizedResource(**values)


async def resolve_authorized_resource(client, resource_id: str) -> AuthorizedResource:
    """Resolve through the caller JWT/RLS before privileged access is possible."""
    rows = await client.rest(
        "GET",
        "server_resources",
        params={
            "id": f"eq.{resource_id}",
            "select": ",".join(
                (
                    "id",
                    "server_id",
                    "uploader_id",
                    "original_filename",
                    "storage_bucket",
                    "storage_path",
                    "visibility",
                    "index_status",
                    "index_started_at",
                )
            ),
            "limit": "1",
        },
    )
    if not rows:
        raise Rag2IndexingError(404, "Resource not found.")
    return _canonical_resource(rows[0])


async def index_authorized_resource(
    resource: AuthorizedResource,
    trusted_client: TrustedIndexingClient,
    *,
    embeddings=None,
) -> IndexingResult:
    """Index a resource only after the caller-facing layer authorized it."""
    attempt_id: str | None = None
    detected_type: str | None = None
    try:
        attempt_id = str(
            await trusted_client.rpc(
                "begin_rag2_resource_indexing",
                {"p_resource_id": resource.id},
            )
        )
        content = await trusted_client.storage_download(
            resource.storage_bucket,
            resource.storage_path,
            max_bytes=10 * 1024 * 1024,
        )
        processed = process_resource_document(resource.original_filename, content)
        detected_type = processed.detected_type
        vectors = await embed_document_chunks(
            processed.chunks,
            embeddings=embeddings,
        )

        for start in range(0, len(processed.chunks), EMBEDDING_BATCH_SIZE):
            batch = [
                {
                    "chunk_index": index,
                    "content": processed.chunks[index],
                    "embedding": vectors[index],
                }
                for index in range(
                    start,
                    min(start + EMBEDDING_BATCH_SIZE, len(processed.chunks)),
                )
            ]
            await trusted_client.rpc(
                "stage_rag2_resource_chunks",
                {
                    "p_resource_id": resource.id,
                    "p_attempt_id": attempt_id,
                    "p_chunks": batch,
                },
            )

        indexed_at_raw = await trusted_client.rpc(
            "complete_rag2_resource_indexing",
            {
                "p_resource_id": resource.id,
                "p_attempt_id": attempt_id,
                "p_detected_type": detected_type,
                "p_size_bytes": len(content),
                "p_content_sha256": hashlib.sha256(content).hexdigest(),
                "p_expected_chunk_count": len(processed.chunks),
            },
        )
        return IndexingResult(
            resource_id=resource.id,
            server_id=resource.server_id,
            detected_type=detected_type,
            chunk_count=len(processed.chunks),
            indexed_at=datetime.fromisoformat(str(indexed_at_raw).replace("Z", "+00:00")),
        )
    except Rag2DocumentError as error:
        primary = Rag2IndexingError(error.status_code, error.detail)
    except Rag2EmbeddingError:
        primary = Rag2IndexingError(502, "Document embeddings could not be generated.")
    except Rag2IndexingError as error:
        primary = error
    except Exception as error:
        error_text = str(error).lower()
        upstream_status = getattr(error, "status_code", None)
        if upstream_status == 409:
            primary = Rag2IndexingError(
                409,
                "The resource indexing state changed. Refresh and try again.",
            )
        elif upstream_status == 422:
            primary = Rag2IndexingError(
                422,
                "This resource is not supported for RAG 2 indexing.",
            )
        elif "rag2_download_too_large" in error_text:
            primary = Rag2IndexingError(413, "RAG 2 resources must be 10 MB or smaller.")
        elif attempt_id is None and (
            "already indexed" in error_text
            or "already in progress" in error_text
            or "indexing attempt" in error_text
        ):
            primary = Rag2IndexingError(409, "The resource cannot begin indexing.")
        elif attempt_id is not None and "storage" in error_text:
            primary = Rag2IndexingError(503, "The canonical Storage object is unavailable.")
        else:
            primary = Rag2IndexingError(500, "Resource indexing could not be completed.")

    if attempt_id is not None:
        try:
            await trusted_client.rpc(
                "fail_rag2_resource_indexing",
                {
                    "p_resource_id": resource.id,
                    "p_attempt_id": attempt_id,
                    "p_detected_type": detected_type,
                },
            )
        except Exception as cleanup_error:
            print(
                "[RAG2-INDEX] failure cleanup rejected "
                f"error={type(cleanup_error).__name__}"
            )
    raise primary
