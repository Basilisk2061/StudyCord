"""Caller-scoped canonical resource metadata access for RAG 2."""

from typing import Any, Protocol

from .schemas import ServerResourceSummary


RESOURCE_LIST_COLUMNS = ",".join(
    (
        "id",
        "server_id",
        "title",
        "original_filename",
        "declared_mime_type",
        "detected_type",
        "size_bytes",
        "visibility",
        "index_status",
        "created_at",
        "updated_at",
    )
)


class CallerScopedRestClient(Protocol):
    async def rest(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json_body: Any = None,
        prefer: str | None = None,
    ) -> Any: ...


async def list_server_resources(
    client: CallerScopedRestClient,
    server_id: str,
    *,
    limit: int = 50,
    offset: int = 0,
) -> list[ServerResourceSummary]:
    """List only RLS-visible metadata for one already-authorized server."""
    if limit < 1 or limit > 100:
        raise ValueError("limit must be between 1 and 100.")
    if offset < 0:
        raise ValueError("offset cannot be negative.")

    rows = await client.rest(
        "GET",
        "server_resources",
        params={
            "server_id": f"eq.{server_id}",
            "select": RESOURCE_LIST_COLUMNS,
            "order": "created_at.desc,id.asc",
            "limit": str(limit),
            "offset": str(offset),
        },
    )
    return [
        ServerResourceSummary.model_validate(row)
        for row in (rows or [])
    ]
