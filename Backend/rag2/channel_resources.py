"""Bounded safe metadata for RAG 2 resources linked from channel attachments."""

from .schemas import ChannelResourceCardMetadata


class Rag2ChannelResourceError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


async def get_channel_resource_metadata(
    client,
    server_id: str,
    resource_ids: list[str],
) -> list[ChannelResourceCardMetadata]:
    if not resource_ids:
        return []
    if len(resource_ids) > 200:
        raise Rag2ChannelResourceError(
            422,
            "Request at most 200 channel resources.",
        )
    try:
        rows = await client.rpc(
            "get_channel_resource_card_metadata",
            {
                "p_server_id": server_id,
                "p_resource_ids": resource_ids,
            },
        )
        return [
            ChannelResourceCardMetadata.model_validate(row)
            for row in (rows or [])
        ]
    except Rag2ChannelResourceError:
        raise
    except Exception as error:
        status_code = getattr(error, "status_code", 500)
        if status_code not in {401, 403, 422}:
            status_code = 500
        detail = (
            "Current server access is required."
            if status_code in {401, 403}
            else "Channel resource metadata could not be loaded."
        )
        raise Rag2ChannelResourceError(status_code, detail) from error
