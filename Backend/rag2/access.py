"""Authorized access to canonical RAG 2 resource files."""

from dataclasses import dataclass
from collections.abc import Awaitable, Callable
from typing import Any

from .indexing import has_safe_canonical_storage_path


RESOURCE_ACCESS_MAX_BYTES = 10 * 1024 * 1024
RESOURCE_ACCESS_BUCKET = "channel-files"
RESOURCE_MEDIA_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "txt": "text/plain; charset=utf-8",
}


@dataclass(frozen=True)
class ResourceAccessRecord:
    id: str
    server_id: str
    original_filename: str
    storage_bucket: str
    storage_path: str
    visibility: str
    index_status: str
    detected_type: str | None
    size_bytes: int | None


@dataclass(frozen=True)
class ResourceAccessPayload:
    content: bytes
    media_type: str
    filename: str
    inline: bool


class Rag2ResourceAccessError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _canonical_access_record(row: dict[str, Any]) -> ResourceAccessRecord:
    required = (
        "id",
        "server_id",
        "original_filename",
        "storage_bucket",
        "storage_path",
        "visibility",
        "index_status",
    )
    if any(not row.get(field) for field in required):
        raise Rag2ResourceAccessError(404, "Resource not found.")
    size_bytes = row.get("size_bytes")
    if size_bytes is not None:
        try:
            size_bytes = int(size_bytes)
        except (TypeError, ValueError) as error:
            raise Rag2ResourceAccessError(404, "Resource not found.") from error
    return ResourceAccessRecord(
        id=str(row["id"]),
        server_id=str(row["server_id"]),
        original_filename=str(row["original_filename"]),
        storage_bucket=str(row["storage_bucket"]),
        storage_path=str(row["storage_path"]),
        visibility=str(row["visibility"]),
        index_status=str(row["index_status"]),
        detected_type=(
            str(row["detected_type"])
            if row.get("detected_type") is not None
            else None
        ),
        size_bytes=size_bytes,
    )


async def resolve_resource_for_access(client, resource_id: str) -> ResourceAccessRecord:
    """Resolve canonical metadata through the caller JWT and resource RLS."""
    rows = await client.rest(
        "GET",
        "server_resources",
        params={
            "id": f"eq.{resource_id}",
            "select": ",".join(
                (
                    "id",
                    "server_id",
                    "original_filename",
                    "storage_bucket",
                    "storage_path",
                    "visibility",
                    "index_status",
                    "detected_type",
                    "size_bytes",
                )
            ),
            "limit": "1",
        },
    )
    if not rows:
        raise Rag2ResourceAccessError(404, "Resource not found.")
    return _canonical_access_record(rows[0])


def validate_resource_for_access(resource: ResourceAccessRecord) -> None:
    """Reject resources outside the currently supported server-visible scope."""
    if (
        resource.visibility != "server"
        or resource.index_status != "ready"
        or resource.storage_bucket != RESOURCE_ACCESS_BUCKET
        or resource.detected_type not in RESOURCE_MEDIA_TYPES
        or not has_safe_canonical_storage_path(resource.storage_path)
        or resource.size_bytes is None
        or resource.size_bytes <= 0
        or resource.size_bytes > RESOURCE_ACCESS_MAX_BYTES
    ):
        raise Rag2ResourceAccessError(404, "Resource not found.")


async def authorize_resource_for_access(
    client,
    resource_id: str,
    user_id: str,
    require_permission: Callable[
        [Any, str, str, str],
        Awaitable[str],
    ],
) -> ResourceAccessRecord:
    """Apply the shared caller-scoped checks before trusted Storage access."""
    resource = await resolve_resource_for_access(client, resource_id)
    await require_permission(
        client,
        resource.server_id,
        user_id,
        "view_server",
    )
    validate_resource_for_access(resource)
    return resource


def safe_download_filename(filename: str, detected_type: str) -> str:
    """Produce a header-safe filename without altering the stored object."""
    cleaned = filename.replace("\\", "_").replace("/", "_")
    cleaned = "".join(
        character
        for character in cleaned
        if 32 <= ord(character) < 127 and character not in {'"', ";"}
    ).strip(" .")
    if not cleaned:
        cleaned = f"resource.{detected_type}"
    return cleaned[:180]


async def download_resource_for_access(
    resource: ResourceAccessRecord,
    trusted_client,
) -> ResourceAccessPayload:
    """Download only a previously authorized and validated canonical object."""
    validate_resource_for_access(resource)
    try:
        content = await trusted_client.storage_download(
            resource.storage_bucket,
            resource.storage_path,
            max_bytes=RESOURCE_ACCESS_MAX_BYTES,
        )
    except Exception as error:
        raise Rag2ResourceAccessError(
            500,
            "Unable to open this resource.",
        ) from error
    if not content:
        raise Rag2ResourceAccessError(500, "Unable to open this resource.")
    detected_type = resource.detected_type or ""
    return ResourceAccessPayload(
        content=content,
        media_type=RESOURCE_MEDIA_TYPES[detected_type],
        filename=safe_download_filename(
            resource.original_filename,
            detected_type,
        ),
        inline=detected_type in {"pdf", "txt"},
    )
