"""Local study-session services for personal RAG 1 history."""

from dataclasses import replace
from datetime import datetime, timezone

from .db import RagSession, RagSessionDetails, RagSessionRepository
from .paths import validate_uuid


class RagSessionError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_study_session(
    user_id: str,
    document_id: str,
    title: str,
    *,
    repository: RagSessionRepository | None = None,
) -> RagSession:
    """Create one backend-identified session for a completed new document."""
    repository = repository or RagSessionRepository()
    return repository.create_for_document(
        user_id,
        document_id,
        title,
        _utc_now(),
    )


def list_study_sessions(
    user_id: str,
    *,
    repository: RagSessionRepository | None = None,
) -> list[RagSessionDetails]:
    repository = repository or RagSessionRepository()
    return repository.list_for_user(user_id)


def open_study_session(
    user_id: str,
    session_id: str,
    *,
    repository: RagSessionRepository | None = None,
) -> RagSessionDetails:
    """Validate ownership/document readiness and mark an explicit open."""
    try:
        canonical_user_id = str(validate_uuid(user_id, "user id"))
        canonical_session_id = str(validate_uuid(session_id, "session id"))
    except ValueError as error:
        raise RagSessionError(404, "Study session not found.") from error

    repository = repository or RagSessionRepository()
    session = repository.get_for_user(
        canonical_session_id,
        canonical_user_id,
    )
    if (
        session is None
        or session.original_filename is None
        or session.detected_type is None
        or session.document_status is None
    ):
        raise RagSessionError(404, "Study session not found.")
    if session.document_status != "ready":
        raise RagSessionError(409, "The session document is not ready.")

    opened_at = _utc_now()
    if not repository.touch_for_user(
        canonical_session_id,
        canonical_user_id,
        opened_at,
    ):
        raise RagSessionError(404, "Study session not found.")
    return replace(session, updated_at=opened_at)


def session_response(session: RagSessionDetails) -> dict[str, str]:
    """Return only frontend-safe session and document metadata."""
    return {
        "id": session.id,
        "document_id": session.document_id,
        "title": session.title,
        "original_filename": session.original_filename or session.title,
        "detected_type": session.detected_type or "",
        "created_at": session.created_at,
        "updated_at": session.updated_at,
    }
