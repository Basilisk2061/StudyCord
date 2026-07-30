"""SQLite metadata storage for the personal RAG 1 Study Helper."""

import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from collections.abc import Iterator

from .paths import DATABASE_FILENAME, ensure_data_directories, get_rag1_data_dir, validate_uuid


BUSY_TIMEOUT_MS = 5000
DETECTED_TYPES = frozenset({"pdf", "txt", "docx"})
DOCUMENT_STATUSES = frozenset({"processing", "ready", "failed", "deleting"})
_UNSET = object()

SCHEMA_SQL = """
create table if not exists rag_documents (
    id text primary key,
    user_id text not null,
    original_filename text not null,
    detected_type text not null
        check (detected_type in ('pdf', 'txt', 'docx')),
    size_bytes integer not null
        check (size_bytes > 0),
    status text not null
        check (status in ('processing', 'ready', 'failed', 'deleting')),
    chunk_count integer
        check (chunk_count is null or chunk_count >= 0),
    artifact_version integer not null default 1
        check (artifact_version >= 1),
    created_at text not null,
    updated_at text not null
);

create index if not exists idx_rag_documents_user_created
    on rag_documents (user_id, created_at desc);

create index if not exists idx_rag_documents_status_updated
    on rag_documents (status, updated_at);

create unique index if not exists uq_rag_documents_id_user
    on rag_documents (id, user_id);

create table if not exists rag_sessions (
    id text primary key,
    user_id text not null,
    document_id text not null,
    title text not null,
    created_at text not null,
    updated_at text not null,
    foreign key (document_id, user_id)
        references rag_documents (id, user_id)
        on delete cascade
);

create index if not exists idx_rag_sessions_user_updated
    on rag_sessions (user_id, updated_at desc, created_at desc);

create index if not exists idx_rag_sessions_document
    on rag_sessions (document_id);

create unique index if not exists uq_rag_sessions_id_user
    on rag_sessions (id, user_id);

create table if not exists rag1_resource_imports (
    user_id text not null,
    rag2_resource_id text not null,
    source_server_id text not null,
    rag1_document_id text,
    rag1_session_id text,
    status text not null
        check (status in ('processing', 'document_ready', 'ready', 'failed')),
    attempt_id text not null,
    created_at text not null,
    updated_at text not null,
    primary key (user_id, rag2_resource_id),
    unique (rag1_document_id),
    unique (rag1_session_id),
    foreign key (rag1_document_id, user_id)
        references rag_documents (id, user_id)
        on delete cascade,
    foreign key (rag1_session_id, user_id)
        references rag_sessions (id, user_id)
        on delete cascade,
    check (
        (status = 'processing' and rag1_session_id is null)
        or (
            status = 'document_ready'
            and rag1_document_id is not null
            and rag1_session_id is null
        )
        or (
            status = 'ready'
            and rag1_document_id is not null
            and rag1_session_id is not null
        )
        or (
            status = 'failed'
            and rag1_document_id is null
            and rag1_session_id is null
        )
    )
);

create index if not exists idx_rag1_resource_imports_status_updated
    on rag1_resource_imports (status, updated_at);
"""


@dataclass(frozen=True)
class RagDocument:
    id: str
    user_id: str
    original_filename: str
    detected_type: str
    size_bytes: int
    status: str
    chunk_count: int | None
    artifact_version: int
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class RagSession:
    id: str
    user_id: str
    document_id: str
    title: str
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class RagSessionDetails:
    id: str
    user_id: str
    document_id: str
    title: str
    created_at: str
    updated_at: str
    original_filename: str | None
    detected_type: str | None
    document_status: str | None


@dataclass(frozen=True)
class RagResourceImport:
    user_id: str
    rag2_resource_id: str
    source_server_id: str
    rag1_document_id: str | None
    rag1_session_id: str | None
    status: str
    attempt_id: str
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class RagResourceImportClaim:
    action: str
    record: RagResourceImport


@contextmanager
def _connection(database_path: Path) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(
        database_path,
        timeout=BUSY_TIMEOUT_MS / 1000,
    )
    connection.row_factory = sqlite3.Row
    connection.execute(f"pragma busy_timeout = {BUSY_TIMEOUT_MS}")
    connection.execute("pragma foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database(data_dir: Path | str | None = None) -> Path:
    """Create or upgrade the idempotent local RAG 1 SQLite foundation."""
    root = ensure_data_directories(data_dir)
    database_path = root / DATABASE_FILENAME
    with _connection(database_path) as connection:
        connection.execute("pragma journal_mode = WAL")
        connection.executescript(SCHEMA_SQL)
    return database_path


def _validate_document(document: RagDocument) -> RagDocument:
    canonical_document_id = str(validate_uuid(document.id, "document id"))
    canonical_user_id = str(validate_uuid(document.user_id, "user id"))
    if not document.original_filename.strip():
        raise ValueError("original_filename is required.")
    if document.detected_type not in DETECTED_TYPES:
        raise ValueError("detected_type is not supported.")
    if document.size_bytes <= 0:
        raise ValueError("size_bytes must be positive.")
    if document.status not in DOCUMENT_STATUSES:
        raise ValueError("status is invalid.")
    if document.chunk_count is not None and document.chunk_count < 0:
        raise ValueError("chunk_count cannot be negative.")
    if document.artifact_version < 1:
        raise ValueError("artifact_version must be at least 1.")
    return RagDocument(
        id=canonical_document_id,
        user_id=canonical_user_id,
        original_filename=document.original_filename,
        detected_type=document.detected_type,
        size_bytes=document.size_bytes,
        status=document.status,
        chunk_count=document.chunk_count,
        artifact_version=document.artifact_version,
        created_at=document.created_at,
        updated_at=document.updated_at,
    )


def _row_to_document(row: sqlite3.Row | None) -> RagDocument | None:
    return RagDocument(**dict(row)) if row is not None else None


def _row_to_session_details(
    row: sqlite3.Row | None,
) -> RagSessionDetails | None:
    return RagSessionDetails(**dict(row)) if row is not None else None


def _row_to_resource_import(
    row: sqlite3.Row | None,
) -> RagResourceImport | None:
    return RagResourceImport(**dict(row)) if row is not None else None


class RagDocumentRepository:
    """Short, parameterized SQLite operations for RAG document metadata."""

    def __init__(self, data_dir: Path | str | None = None):
        self.data_dir = get_rag1_data_dir(data_dir)
        self.database_path = initialize_database(self.data_dir)

    def create(self, document: RagDocument) -> RagDocument:
        validated = _validate_document(document)
        with _connection(self.database_path) as connection:
            connection.execute(
                """
                insert into rag_documents (
                    id,
                    user_id,
                    original_filename,
                    detected_type,
                    size_bytes,
                    status,
                    chunk_count,
                    artifact_version,
                    created_at,
                    updated_at
                )
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    validated.id,
                    validated.user_id,
                    validated.original_filename,
                    validated.detected_type,
                    validated.size_bytes,
                    validated.status,
                    validated.chunk_count,
                    validated.artifact_version,
                    validated.created_at,
                    validated.updated_at,
                ),
            )
        return validated

    def get_for_user(
        self,
        document_id: str | uuid.UUID,
        user_id: str | uuid.UUID,
    ) -> RagDocument | None:
        canonical_document_id = str(validate_uuid(document_id, "document id"))
        canonical_user_id = str(validate_uuid(user_id, "user id"))
        with _connection(self.database_path) as connection:
            row = connection.execute(
                """
                select *
                from rag_documents
                where id = ? and user_id = ?
                """,
                (canonical_document_id, canonical_user_id),
            ).fetchone()
        return _row_to_document(row)

    def list_for_user(self, user_id: str | uuid.UUID) -> list[RagDocument]:
        canonical_user_id = str(validate_uuid(user_id, "user id"))
        with _connection(self.database_path) as connection:
            rows = connection.execute(
                """
                select *
                from rag_documents
                where user_id = ?
                order by created_at desc
                """,
                (canonical_user_id,),
            ).fetchall()
        return [RagDocument(**dict(row)) for row in rows]

    def update_status_for_user(
        self,
        document_id: str | uuid.UUID,
        user_id: str | uuid.UUID,
        status: str,
        updated_at: str,
        *,
        chunk_count: int | None | object = _UNSET,
    ) -> bool:
        canonical_document_id = str(validate_uuid(document_id, "document id"))
        canonical_user_id = str(validate_uuid(user_id, "user id"))
        if status not in DOCUMENT_STATUSES:
            raise ValueError("status is invalid.")
        if (
            chunk_count is not _UNSET
            and chunk_count is not None
            and chunk_count < 0
        ):
            raise ValueError("chunk_count cannot be negative.")
        with _connection(self.database_path) as connection:
            if chunk_count is _UNSET:
                cursor = connection.execute(
                    """
                    update rag_documents
                    set status = ?, updated_at = ?
                    where id = ? and user_id = ?
                    """,
                    (
                        status,
                        updated_at,
                        canonical_document_id,
                        canonical_user_id,
                    ),
                )
            else:
                cursor = connection.execute(
                    """
                    update rag_documents
                    set status = ?, chunk_count = ?, updated_at = ?
                    where id = ? and user_id = ?
                    """,
                    (
                        status,
                        chunk_count,
                        updated_at,
                        canonical_document_id,
                        canonical_user_id,
                    ),
                )
        return cursor.rowcount == 1

    def delete_for_user(
        self,
        document_id: str | uuid.UUID,
        user_id: str | uuid.UUID,
    ) -> bool:
        canonical_document_id = str(validate_uuid(document_id, "document id"))
        canonical_user_id = str(validate_uuid(user_id, "user id"))
        with _connection(self.database_path) as connection:
            cursor = connection.execute(
                """
                delete from rag_documents
                where id = ? and user_id = ?
                """,
                (canonical_document_id, canonical_user_id),
            )
        return cursor.rowcount == 1


class RagSessionRepository:
    """Ownership-scoped local study-session metadata operations."""

    def __init__(self, data_dir: Path | str | None = None):
        self.data_dir = get_rag1_data_dir(data_dir)
        self.database_path = initialize_database(self.data_dir)

    def create_for_document(
        self,
        user_id: str | uuid.UUID,
        document_id: str | uuid.UUID,
        title: str,
        timestamp: str,
    ) -> RagSession:
        canonical_user_id = str(validate_uuid(user_id, "user id"))
        canonical_document_id = str(validate_uuid(document_id, "document id"))
        cleaned_title = title.strip()
        if not cleaned_title:
            raise ValueError("title is required.")
        session = RagSession(
            id=str(uuid.uuid4()),
            user_id=canonical_user_id,
            document_id=canonical_document_id,
            title=cleaned_title[:255],
            created_at=timestamp,
            updated_at=timestamp,
        )
        with _connection(self.database_path) as connection:
            document = connection.execute(
                """
                select status
                from rag_documents
                where id = ? and user_id = ?
                """,
                (canonical_document_id, canonical_user_id),
            ).fetchone()
            if document is None:
                raise ValueError("Document is unavailable.")
            if document["status"] != "ready":
                raise ValueError("Document is not ready.")
            connection.execute(
                """
                insert into rag_sessions (
                    id,
                    user_id,
                    document_id,
                    title,
                    created_at,
                    updated_at
                )
                values (?, ?, ?, ?, ?, ?)
                """,
                (
                    session.id,
                    session.user_id,
                    session.document_id,
                    session.title,
                    session.created_at,
                    session.updated_at,
                ),
            )
        return session

    def list_for_user(
        self,
        user_id: str | uuid.UUID,
    ) -> list[RagSessionDetails]:
        canonical_user_id = str(validate_uuid(user_id, "user id"))
        with _connection(self.database_path) as connection:
            rows = connection.execute(
                """
                select
                    s.id,
                    s.user_id,
                    s.document_id,
                    s.title,
                    s.created_at,
                    s.updated_at,
                    d.original_filename,
                    d.detected_type,
                    d.status as document_status
                from rag_sessions as s
                join rag_documents as d
                    on d.id = s.document_id
                    and d.user_id = s.user_id
                where s.user_id = ?
                    and d.status = 'ready'
                order by s.updated_at desc, s.created_at desc
                """,
                (canonical_user_id,),
            ).fetchall()
        return [RagSessionDetails(**dict(row)) for row in rows]

    def get_for_user(
        self,
        session_id: str | uuid.UUID,
        user_id: str | uuid.UUID,
    ) -> RagSessionDetails | None:
        canonical_session_id = str(validate_uuid(session_id, "session id"))
        canonical_user_id = str(validate_uuid(user_id, "user id"))
        with _connection(self.database_path) as connection:
            row = connection.execute(
                """
                select
                    s.id,
                    s.user_id,
                    s.document_id,
                    s.title,
                    s.created_at,
                    s.updated_at,
                    d.original_filename,
                    d.detected_type,
                    d.status as document_status
                from rag_sessions as s
                left join rag_documents as d
                    on d.id = s.document_id
                    and d.user_id = s.user_id
                where s.id = ? and s.user_id = ?
                """,
                (canonical_session_id, canonical_user_id),
            ).fetchone()
        return _row_to_session_details(row)

    def touch_for_user(
        self,
        session_id: str | uuid.UUID,
        user_id: str | uuid.UUID,
        updated_at: str,
    ) -> bool:
        canonical_session_id = str(validate_uuid(session_id, "session id"))
        canonical_user_id = str(validate_uuid(user_id, "user id"))
        with _connection(self.database_path) as connection:
            cursor = connection.execute(
                """
                update rag_sessions
                set updated_at = ?
                where id = ? and user_id = ?
                """,
                (
                    updated_at,
                    canonical_session_id,
                    canonical_user_id,
                ),
            )
        return cursor.rowcount == 1

    def get_latest_for_document(
        self,
        user_id: str | uuid.UUID,
        document_id: str | uuid.UUID,
    ) -> RagSessionDetails | None:
        canonical_user_id = str(validate_uuid(user_id, "user id"))
        canonical_document_id = str(validate_uuid(document_id, "document id"))
        with _connection(self.database_path) as connection:
            row = connection.execute(
                """
                select
                    s.id,
                    s.user_id,
                    s.document_id,
                    s.title,
                    s.created_at,
                    s.updated_at,
                    d.original_filename,
                    d.detected_type,
                    d.status as document_status
                from rag_sessions as s
                join rag_documents as d
                    on d.id = s.document_id
                    and d.user_id = s.user_id
                where s.user_id = ? and s.document_id = ?
                order by s.created_at asc, s.id asc
                limit 1
                """,
                (canonical_user_id, canonical_document_id),
            ).fetchone()
        return _row_to_session_details(row)


class RagResourceImportRepository:
    """Short SQLite claims for idempotent RAG 2 to RAG 1 handoff."""

    def __init__(self, data_dir: Path | str | None = None):
        self.data_dir = get_rag1_data_dir(data_dir)
        self.database_path = initialize_database(self.data_dir)

    def claim(
        self,
        user_id: str | uuid.UUID,
        rag2_resource_id: str | uuid.UUID,
        source_server_id: str | uuid.UUID,
        attempt_id: str | uuid.UUID,
        timestamp: str,
        stale_before: str,
    ) -> RagResourceImportClaim:
        canonical_user_id = str(validate_uuid(user_id, "user id"))
        canonical_resource_id = str(
            validate_uuid(rag2_resource_id, "RAG 2 resource id")
        )
        canonical_server_id = str(validate_uuid(source_server_id, "server id"))
        canonical_attempt_id = str(validate_uuid(attempt_id, "attempt id"))
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        datetime.fromisoformat(stale_before.replace("Z", "+00:00"))

        with _connection(self.database_path) as connection:
            connection.execute("begin immediate")
            row = connection.execute(
                """
                select *
                from rag1_resource_imports
                where user_id = ? and rag2_resource_id = ?
                """,
                (canonical_user_id, canonical_resource_id),
            ).fetchone()

            if row is None:
                connection.execute(
                    """
                    insert into rag1_resource_imports (
                        user_id,
                        rag2_resource_id,
                        source_server_id,
                        rag1_document_id,
                        rag1_session_id,
                        status,
                        attempt_id,
                        created_at,
                        updated_at
                    )
                    values (?, ?, ?, null, null, 'processing', ?, ?, ?)
                    """,
                    (
                        canonical_user_id,
                        canonical_resource_id,
                        canonical_server_id,
                        canonical_attempt_id,
                        timestamp,
                        timestamp,
                    ),
                )
                action = "ingest"
            else:
                current = _row_to_resource_import(row)
                if current is None:
                    raise RuntimeError("Resource import could not be loaded.")
                if current.status == "ready":
                    return RagResourceImportClaim("ready", current)
                if current.status == "processing" and current.updated_at > stale_before:
                    return RagResourceImportClaim("processing", current)

                preserve_document = (
                    current.rag1_document_id
                    if current.status in {"processing", "document_ready"}
                    else None
                )
                connection.execute(
                    """
                    update rag1_resource_imports
                    set
                        source_server_id = ?,
                        rag1_document_id = ?,
                        rag1_session_id = null,
                        status = 'processing',
                        attempt_id = ?,
                        updated_at = ?
                    where user_id = ? and rag2_resource_id = ?
                    """,
                    (
                        canonical_server_id,
                        preserve_document,
                        canonical_attempt_id,
                        timestamp,
                        canonical_user_id,
                        canonical_resource_id,
                    ),
                )
                action = "recover_document" if preserve_document else "ingest"

            claimed = connection.execute(
                """
                select *
                from rag1_resource_imports
                where user_id = ? and rag2_resource_id = ?
                """,
                (canonical_user_id, canonical_resource_id),
            ).fetchone()
        record = _row_to_resource_import(claimed)
        if record is None:
            raise RuntimeError("Resource import claim could not be loaded.")
        return RagResourceImportClaim(action, record)

    def attach_document(
        self,
        user_id: str,
        rag2_resource_id: str,
        attempt_id: str,
        document_id: str,
        timestamp: str,
    ) -> bool:
        return self._attempt_update(
            user_id,
            rag2_resource_id,
            attempt_id,
            """
            update rag1_resource_imports
            set rag1_document_id = ?, updated_at = ?
            where user_id = ?
              and rag2_resource_id = ?
              and attempt_id = ?
              and status = 'processing'
              and rag1_document_id is null
            """,
            (
                str(validate_uuid(document_id, "document id")),
                timestamp,
            ),
        )

    def mark_ready(
        self,
        user_id: str,
        rag2_resource_id: str,
        attempt_id: str,
        session_id: str,
        timestamp: str,
    ) -> bool:
        return self._attempt_update(
            user_id,
            rag2_resource_id,
            attempt_id,
            """
            update rag1_resource_imports
            set rag1_session_id = ?, status = 'ready', updated_at = ?
            where user_id = ?
              and rag2_resource_id = ?
              and attempt_id = ?
              and status = 'processing'
              and rag1_document_id is not null
            """,
            (
                str(validate_uuid(session_id, "session id")),
                timestamp,
            ),
        )

    def mark_document_ready(
        self,
        user_id: str,
        rag2_resource_id: str,
        attempt_id: str,
        timestamp: str,
    ) -> bool:
        return self._attempt_update(
            user_id,
            rag2_resource_id,
            attempt_id,
            """
            update rag1_resource_imports
            set status = 'document_ready', updated_at = ?
            where user_id = ?
              and rag2_resource_id = ?
              and attempt_id = ?
              and status = 'processing'
              and rag1_document_id is not null
            """,
            (timestamp,),
        )

    def mark_failed(
        self,
        user_id: str,
        rag2_resource_id: str,
        attempt_id: str,
        timestamp: str,
    ) -> bool:
        return self._attempt_update(
            user_id,
            rag2_resource_id,
            attempt_id,
            """
            update rag1_resource_imports
            set
                rag1_document_id = null,
                rag1_session_id = null,
                status = 'failed',
                updated_at = ?
            where user_id = ?
              and rag2_resource_id = ?
              and attempt_id = ?
              and status = 'processing'
              and rag1_document_id is null
            """,
            (timestamp,),
        )

    def _attempt_update(
        self,
        user_id: str,
        rag2_resource_id: str,
        attempt_id: str,
        sql: str,
        values: tuple,
    ) -> bool:
        canonical_user_id = str(validate_uuid(user_id, "user id"))
        canonical_resource_id = str(
            validate_uuid(rag2_resource_id, "RAG 2 resource id")
        )
        canonical_attempt_id = str(validate_uuid(attempt_id, "attempt id"))
        with _connection(self.database_path) as connection:
            cursor = connection.execute(
                sql,
                (
                    *values,
                    canonical_user_id,
                    canonical_resource_id,
                    canonical_attempt_id,
                ),
            )
        return cursor.rowcount == 1
