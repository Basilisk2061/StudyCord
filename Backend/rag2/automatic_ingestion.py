"""Caller-scoped registration for newly persisted RAG 2 attachments."""

import uuid


class Rag2AutomaticIngestionError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


async def register_attachment_for_rag2(client, attachment_id: str) -> str:
    """Reuse the Phase 18.1B RPC; never accept client Storage metadata."""
    try:
        resource_id = await client.rpc(
            "register_server_resource_from_attachment",
            {
                "p_attachment_id": attachment_id,
                "p_title": None,
            },
        )
    except Exception as error:
        status_code = getattr(error, "status_code", 500)
        if status_code not in {401, 403, 404, 422}:
            status_code = 500
        detail = (
            "This attachment is not eligible for semantic search."
            if status_code in {403, 404, 422}
            else "Automatic semantic registration failed."
        )
        raise Rag2AutomaticIngestionError(status_code, detail) from error

    try:
        return str(uuid.UUID(str(resource_id)))
    except (TypeError, ValueError, AttributeError) as error:
        raise Rag2AutomaticIngestionError(
            500,
            "Automatic semantic registration failed.",
        ) from error
