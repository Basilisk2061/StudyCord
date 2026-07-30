"""Authorized, idempotent RAG 2 resource imports into personal RAG 1."""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from rag2.access import (
    Rag2ResourceAccessError,
    authorize_resource_for_access,
    download_resource_for_access,
)

from .db import (
    RagDocumentRepository,
    RagResourceImport,
    RagResourceImportRepository,
    RagSessionRepository,
)
from .ingestion import RagIngestionError, ingest_rag_document_bytes
from .paths import remove_document_directory
from .service import cache_rag_document
from .sessions import create_study_session


IMPORT_STALE_AFTER = timedelta(minutes=30)


class Rag1HandoffError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class Rag1HandoffResult:
    doc_id: str
    session_id: str
    filename: str
    detected_type: str
    reused: bool


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _ready_result(
    record: RagResourceImport,
    documents: RagDocumentRepository,
    sessions: RagSessionRepository,
    *,
    reused: bool,
) -> Rag1HandoffResult:
    if not record.rag1_document_id or not record.rag1_session_id:
        raise Rag1HandoffError(500, "The RAG 1 import could not be restored.")
    document = documents.get_for_user(
        record.rag1_document_id,
        record.user_id,
    )
    session = sessions.get_for_user(
        record.rag1_session_id,
        record.user_id,
    )
    if (
        document is None
        or document.status != "ready"
        or session is None
        or session.document_id != document.id
        or session.document_status != "ready"
    ):
        raise Rag1HandoffError(500, "The RAG 1 import could not be restored.")
    return Rag1HandoffResult(
        doc_id=document.id,
        session_id=session.id,
        filename=document.original_filename,
        detected_type=document.detected_type,
        reused=reused,
    )


def _compensate_unclaimed_document(
    user_id: str,
    document_id: str,
    documents: RagDocumentRepository,
) -> None:
    try:
        remove_document_directory(user_id, document_id, documents.data_dir)
    except Exception as cleanup_error:
        print(
            "[RAG1-HANDOFF] stale document artifact cleanup failed "
            f"error={type(cleanup_error).__name__}"
        )
    try:
        documents.delete_for_user(document_id, user_id)
    except Exception as cleanup_error:
        print(
            "[RAG1-HANDOFF] stale document metadata cleanup failed "
            f"error={type(cleanup_error).__name__}"
        )


async def handoff_rag2_resource_to_rag1(
    *,
    caller_client,
    user_id: str,
    resource_id: str,
    require_permission,
    trusted_client_factory,
    imports: RagResourceImportRepository | None = None,
    documents: RagDocumentRepository | None = None,
    sessions: RagSessionRepository | None = None,
) -> Rag1HandoffResult:
    """Authorize the live source, then create or reuse one personal import."""
    try:
        resource = await authorize_resource_for_access(
            caller_client,
            resource_id,
            user_id,
            require_permission,
        )
    except Rag2ResourceAccessError as error:
        raise Rag1HandoffError(error.status_code, error.detail) from error

    documents = documents or RagDocumentRepository()
    sessions = sessions or RagSessionRepository(documents.data_dir)
    imports = imports or RagResourceImportRepository(documents.data_dir)

    now = _utc_now()
    attempt_id = str(uuid.uuid4())
    try:
        claim = imports.claim(
            user_id,
            resource.id,
            resource.server_id,
            attempt_id,
            now.isoformat(),
            (now - IMPORT_STALE_AFTER).isoformat(),
        )
    except Exception as error:
        raise Rag1HandoffError(
            500,
            "The RAG 1 import could not be started.",
        ) from error

    if claim.action == "ready":
        return _ready_result(
            claim.record,
            documents,
            sessions,
            reused=True,
        )
    if claim.action == "processing":
        raise Rag1HandoffError(
            409,
            "This resource is already being added to RAG 1. Retry shortly.",
        )

    result = None
    document_id = claim.record.rag1_document_id
    if claim.action == "ingest":
        try:
            trusted_client = trusted_client_factory()
            payload = await download_resource_for_access(
                resource,
                trusted_client,
            )
            result = await ingest_rag_document_bytes(
                payload.content,
                payload.filename,
                resource.detected_type or "",
                user_id,
                repository=documents,
            )
            document_id = result.doc_id
        except RagIngestionError as error:
            imports.mark_failed(
                user_id,
                resource.id,
                attempt_id,
                _utc_now().isoformat(),
            )
            raise Rag1HandoffError(error.status_code, error.detail) from error
        except Rag2ResourceAccessError as error:
            imports.mark_failed(
                user_id,
                resource.id,
                attempt_id,
                _utc_now().isoformat(),
            )
            raise Rag1HandoffError(
                503,
                "The canonical resource is temporarily unavailable.",
            ) from error
        except Rag1HandoffError:
            raise
        except Exception as error:
            imports.mark_failed(
                user_id,
                resource.id,
                attempt_id,
                _utc_now().isoformat(),
            )
            raise Rag1HandoffError(
                500,
                "The resource could not be added to RAG 1.",
            ) from error

        if not imports.attach_document(
            user_id,
            resource.id,
            attempt_id,
            document_id,
            _utc_now().isoformat(),
        ):
            _compensate_unclaimed_document(user_id, document_id, documents)
            raise Rag1HandoffError(
                409,
                "A newer import attempt replaced this request. Retry.",
            )

    if not document_id:
        raise Rag1HandoffError(500, "The RAG 1 document could not be restored.")

    document = documents.get_for_user(document_id, user_id)
    if document is None or document.status != "ready":
        raise Rag1HandoffError(500, "The RAG 1 document could not be restored.")

    try:
        session = sessions.get_latest_for_document(user_id, document_id)
        if session is None:
            created = create_study_session(
                user_id,
                document_id,
                document.original_filename,
                repository=sessions,
            )
            session_id = created.id
        else:
            session_id = session.id
    except Exception as error:
        imports.mark_document_ready(
            user_id,
            resource.id,
            attempt_id,
            _utc_now().isoformat(),
        )
        raise Rag1HandoffError(
            500,
            "The document was added, but its study session could not be created. Retry.",
        ) from error

    if not imports.mark_ready(
        user_id,
        resource.id,
        attempt_id,
        session_id,
        _utc_now().isoformat(),
    ):
        raise Rag1HandoffError(
            409,
            "A newer import attempt replaced this request. Retry.",
        )

    if result is not None:
        cache_rag_document(
            user_id,
            result.doc_id,
            result.vector_store,
            result.text,
            result.filename,
        )

    ready_record = RagResourceImport(
        user_id=claim.record.user_id,
        rag2_resource_id=claim.record.rag2_resource_id,
        source_server_id=claim.record.source_server_id,
        rag1_document_id=document_id,
        rag1_session_id=session_id,
        status="ready",
        attempt_id=attempt_id,
        created_at=claim.record.created_at,
        updated_at=_utc_now().isoformat(),
    )
    return _ready_result(
        ready_record,
        documents,
        sessions,
        reused=False,
    )
