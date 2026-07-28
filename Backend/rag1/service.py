"""Ownership-safe lazy restoration for persistent personal RAG 1 documents."""

from dataclasses import dataclass
from pathlib import Path

from langchain_community.vectorstores import FAISS
from langchain_google_genai import GoogleGenerativeAIEmbeddings

from .db import RagDocument, RagDocumentRepository
from .ingestion import EMBEDDING_MODEL
from .paths import (
    DOCUMENT_TEXT_FILENAME,
    FAISS_DOCSTORE_FILENAME,
    FAISS_INDEX_FILENAME,
    get_document_artifact_path,
    get_document_directory,
    validate_uuid,
)


class RagDocumentResolutionError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class CachedRagDocument:
    vector_store: FAISS
    text: str
    filename: str


@dataclass(frozen=True)
class ResolvedRagDocument:
    metadata: RagDocument
    vector_store: FAISS
    text: str
    filename: str


# Process-local performance cache only. SQLite and backend-controlled artifacts
# remain authoritative, and ownership is checked before this cache is consulted.
_document_cache: dict[tuple[str, str], CachedRagDocument] = {}


def _canonical_cache_key(user_id: str, document_id: str) -> tuple[str, str]:
    return (
        str(validate_uuid(user_id, "user id")),
        str(validate_uuid(document_id, "document id")),
    )


def clear_rag_document_cache() -> None:
    """Clear only the process-local cache, as happens naturally on restart."""
    _document_cache.clear()


def is_rag_document_cached(user_id: str, document_id: str) -> bool:
    try:
        key = _canonical_cache_key(user_id, document_id)
    except ValueError:
        return False
    return key in _document_cache


def cache_rag_document(
    user_id: str,
    document_id: str,
    vector_store: FAISS,
    text: str,
    filename: str,
) -> None:
    """Prime the cache after an ingestion that already completed durably."""
    key = _canonical_cache_key(user_id, document_id)
    _document_cache[key] = CachedRagDocument(
        vector_store=vector_store,
        text=text,
        filename=filename,
    )


def _require_artifact(path: Path) -> None:
    try:
        valid = (
            path.is_file()
            and not path.is_symlink()
            and path.stat().st_size > 0
        )
    except OSError:
        valid = False
    if not valid:
        raise RagDocumentResolutionError(
            503,
            "The document artifacts are unavailable.",
        )


def _load_vector_store(document_directory: Path) -> FAISS:
    try:
        embeddings = GoogleGenerativeAIEmbeddings(model=EMBEDDING_MODEL)
        # index.pkl is trusted only inside a UUID-derived, containment-checked
        # directory created by this backend after SQLite ownership validation.
        # No frontend-supplied path or filename can reach this deserializer.
        return FAISS.load_local(
            str(document_directory),
            embeddings,
            allow_dangerous_deserialization=True,
        )
    except Exception as error:
        raise RagDocumentResolutionError(
            503,
            "The document index could not be restored.",
        ) from error


def resolve_rag_document(
    user_id: str,
    document_id: str,
    *,
    repository: RagDocumentRepository | None = None,
) -> ResolvedRagDocument:
    """Resolve one ready document after validating authenticated ownership."""
    try:
        canonical_user_id, canonical_document_id = _canonical_cache_key(
            user_id,
            document_id,
        )
    except ValueError as error:
        raise RagDocumentResolutionError(404, "Document not found.") from error

    repository = repository or RagDocumentRepository()
    metadata = repository.get_for_user(
        canonical_document_id,
        canonical_user_id,
    )
    if metadata is None:
        raise RagDocumentResolutionError(404, "Document not found.")
    if metadata.status != "ready":
        raise RagDocumentResolutionError(
            409,
            "The document is not ready.",
        )

    try:
        document_directory = get_document_directory(
            canonical_user_id,
            canonical_document_id,
            repository.data_dir,
        )
        document_text_path = get_document_artifact_path(
            canonical_user_id,
            canonical_document_id,
            DOCUMENT_TEXT_FILENAME,
            repository.data_dir,
        )
        index_path = get_document_artifact_path(
            canonical_user_id,
            canonical_document_id,
            FAISS_INDEX_FILENAME,
            repository.data_dir,
        )
        docstore_path = get_document_artifact_path(
            canonical_user_id,
            canonical_document_id,
            FAISS_DOCSTORE_FILENAME,
            repository.data_dir,
        )
    except ValueError as error:
        raise RagDocumentResolutionError(
            503,
            "The document artifacts are unavailable.",
        ) from error

    for artifact_path in (document_text_path, index_path, docstore_path):
        _require_artifact(artifact_path)

    cache_key = (canonical_user_id, canonical_document_id)
    cached = _document_cache.get(cache_key)
    if cached is None:
        try:
            text = document_text_path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError) as error:
            raise RagDocumentResolutionError(
                503,
                "The document text could not be restored.",
            ) from error
        if not text:
            raise RagDocumentResolutionError(
                503,
                "The document text could not be restored.",
            )
        cached = CachedRagDocument(
            vector_store=_load_vector_store(document_directory),
            text=text,
            filename=metadata.original_filename,
        )
        _document_cache[cache_key] = cached

    return ResolvedRagDocument(
        metadata=metadata,
        vector_store=cached.vector_store,
        text=cached.text,
        filename=cached.filename,
    )
