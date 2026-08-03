"""Phase 19.1 message and membership lifecycle safety helpers."""

import uuid
from dataclasses import dataclass
from typing import Any


CHANNEL_FILES_BUCKET = "channel-files"


class LifecycleTargetError(ValueError):
    """Raised when a privileged Storage target is not backend-verifiable."""


@dataclass(frozen=True)
class MessageDeletionTarget:
    storage_path: str
    server_id: str
    channel_id: str
    user_id: str


def _canonical_uuid(value: Any, field: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as error:
        raise LifecycleTargetError(f"Invalid {field}.") from error


def parse_message_deletion_targets(
    rows: Any,
) -> list[MessageDeletionTarget]:
    """Validate Storage targets returned by the caller-authorized deletion RPC."""
    if rows is None:
        return []
    if not isinstance(rows, list):
        raise LifecycleTargetError("Invalid deletion target response.")

    targets: list[MessageDeletionTarget] = []
    seen_paths: set[str] = set()
    expected_scope: tuple[str, str, str] | None = None

    for row in rows:
        if not isinstance(row, dict):
            raise LifecycleTargetError("Invalid deletion target row.")
        server_id = _canonical_uuid(row.get("server_id"), "server ID")
        channel_id = _canonical_uuid(row.get("channel_id"), "channel ID")
        user_id = _canonical_uuid(row.get("user_id"), "target user ID")
        path = row.get("storage_path")
        row_scope = (server_id, channel_id, user_id)
        if expected_scope is None:
            expected_scope = row_scope
        expected_prefix = f"{server_id}/{channel_id}/{user_id}/"

        if (
            row_scope != expected_scope
            or not isinstance(path, str)
            or len(path) > 1024
            or not path.startswith(expected_prefix)
            or len(path) == len(expected_prefix)
            or "\\" in path
            or "//" in path
            or any(segment in {"", ".", ".."} for segment in path.split("/"))
        ):
            raise LifecycleTargetError("Unsafe channel-file deletion target.")

        if path not in seen_paths:
            seen_paths.add(path)
            targets.append(
                MessageDeletionTarget(
                    storage_path=path,
                    server_id=server_id,
                    channel_id=channel_id,
                    user_id=user_id,
                )
            )

    return targets
