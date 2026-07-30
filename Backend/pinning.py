"""Safe Phase 19.2 pinned-message response shaping."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class PinnedMessageAttachment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID
    file_name: str = Field(min_length=1, max_length=255)
    file_url: str | None = None
    file_type: str | None = None
    file_size: int | None = Field(default=None, ge=0)
    resource_id: uuid.UUID | None = None


class PinnedMessageSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message_id: uuid.UUID
    server_id: uuid.UUID
    channel_id: uuid.UUID
    content: str
    message_created_at: datetime
    author_username: str = Field(min_length=1)
    author_avatar_url: str | None = None
    pinned_at: datetime
    pinned_by_username: str | None = None
    attachment: PinnedMessageAttachment | None = None


class PinResponse(BaseModel):
    success: bool
    message_id: uuid.UUID
    pinned: bool


def _uuid(value: Any, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError, AttributeError) as error:
        raise ValueError(f"Invalid pinned-message {field}.") from error


def shape_pinned_messages(
    rows: Any,
    *,
    expected_server_id: str,
    expected_channel_id: str,
) -> list[PinnedMessageSummary]:
    if not isinstance(rows, list):
        raise ValueError("Invalid pinned-message result.")

    server_id = _uuid(expected_server_id, "server ID")
    channel_id = _uuid(expected_channel_id, "channel ID")
    results: list[PinnedMessageSummary] = []

    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Invalid pinned-message row.")
        if _uuid(row.get("server_id"), "server ID") != server_id:
            raise ValueError("Cross-server pinned-message result.")
        if _uuid(row.get("channel_id"), "channel ID") != channel_id:
            raise ValueError("Cross-channel pinned-message result.")

        attachment = None
        attachment_id = row.get("attachment_id")
        if attachment_id is not None:
            attachment = PinnedMessageAttachment(
                id=_uuid(attachment_id, "attachment ID"),
                file_name=str(row.get("attachment_file_name") or ""),
                file_url=(
                    str(row["attachment_file_url"])
                    if row.get("attachment_file_url") is not None
                    else None
                ),
                file_type=(
                    str(row["attachment_file_type"])
                    if row.get("attachment_file_type") is not None
                    else None
                ),
                file_size=row.get("attachment_file_size"),
                resource_id=(
                    _uuid(row["attachment_resource_id"], "resource ID")
                    if row.get("attachment_resource_id") is not None
                    else None
                ),
            )

        results.append(
            PinnedMessageSummary(
                message_id=_uuid(row.get("message_id"), "message ID"),
                server_id=server_id,
                channel_id=channel_id,
                content=str(row.get("content") or ""),
                message_created_at=str(row.get("message_created_at") or ""),
                author_username=str(row.get("author_username") or "Unknown"),
                author_avatar_url=(
                    str(row["author_avatar_url"])
                    if row.get("author_avatar_url") is not None
                    else None
                ),
                pinned_at=str(row.get("pinned_at") or ""),
                pinned_by_username=(
                    str(row["pinned_by_username"])
                    if row.get("pinned_by_username") is not None
                    else None
                ),
                attachment=attachment,
            )
        )

    return results
