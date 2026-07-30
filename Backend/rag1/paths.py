"""Backend-controlled filesystem paths for RAG 1 artifacts."""

import os
import shutil
import tempfile
import uuid
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_RAG1_DATA_DIR = BACKEND_DIR / "data" / "rag1"
DATABASE_FILENAME = "rag1.sqlite3"
DOCUMENT_TEXT_FILENAME = "document.txt"
FAISS_INDEX_FILENAME = "index.faiss"
FAISS_DOCSTORE_FILENAME = "index.pkl"
ALLOWED_ARTIFACT_FILENAMES = frozenset(
    {
        DOCUMENT_TEXT_FILENAME,
        FAISS_INDEX_FILENAME,
        FAISS_DOCSTORE_FILENAME,
    }
)


def get_rag1_data_dir(data_dir: Path | str | None = None) -> Path:
    """Resolve an explicit path, RAG1_DATA_DIR, or the local development default."""
    configured = data_dir if data_dir is not None else os.getenv("RAG1_DATA_DIR")
    if configured:
        candidate = Path(configured).expanduser()
        if not candidate.is_absolute():
            candidate = BACKEND_DIR / candidate
    else:
        candidate = DEFAULT_RAG1_DATA_DIR
    return candidate.resolve()


def ensure_data_directories(data_dir: Path | str | None = None) -> Path:
    """Create only the root directories required by the persistence foundation."""
    root = get_rag1_data_dir(data_dir)
    root.mkdir(parents=True, exist_ok=True)
    users_root = root / "users"
    staging_root = root / ".staging"
    users_root.mkdir(exist_ok=True)
    staging_root.mkdir(exist_ok=True)
    if users_root.is_symlink() or staging_root.is_symlink():
        raise ValueError("RAG 1 infrastructure directories cannot be symbolic links.")
    _require_within(users_root, root, "Users directory")
    _require_within(staging_root, root, "Staging directory")
    return root


def validate_uuid(value: str | uuid.UUID, label: str) -> uuid.UUID:
    """Require a UUID value and return its canonical representation."""
    try:
        parsed = value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError(f"{label} must be a valid UUID.") from error
    return parsed


def _require_within(path: Path, parent: Path, label: str) -> Path:
    resolved_path = path.resolve()
    resolved_parent = parent.resolve()
    try:
        resolved_path.relative_to(resolved_parent)
    except ValueError as error:
        raise ValueError(f"{label} must remain inside the RAG 1 data directory.") from error
    return resolved_path


def get_user_directory(
    user_id: str | uuid.UUID,
    data_dir: Path | str | None = None,
) -> Path:
    root = get_rag1_data_dir(data_dir)
    users_root = _require_within(root / "users", root, "Users directory")
    canonical_user_id = str(validate_uuid(user_id, "user_id"))
    return _require_within(users_root / canonical_user_id, users_root, "User path")


def get_document_directory(
    user_id: str | uuid.UUID,
    document_id: str | uuid.UUID,
    data_dir: Path | str | None = None,
) -> Path:
    user_directory = get_user_directory(user_id, data_dir)
    canonical_document_id = str(validate_uuid(document_id, "document_id"))
    return _require_within(
        user_directory / canonical_document_id,
        user_directory,
        "Document path",
    )


def get_document_artifact_path(
    user_id: str | uuid.UUID,
    document_id: str | uuid.UUID,
    filename: str,
    data_dir: Path | str | None = None,
) -> Path:
    """Return a path for one fixed backend artifact filename."""
    if filename not in ALLOWED_ARTIFACT_FILENAMES:
        raise ValueError("Artifact filename is not backend-controlled.")
    document_directory = get_document_directory(user_id, document_id, data_dir)
    return _require_within(
        document_directory / filename,
        document_directory,
        "Artifact path",
    )


def create_staging_directory(
    document_id: str | uuid.UUID,
    data_dir: Path | str | None = None,
) -> Path:
    """Create a unique backend-owned staging directory for a document."""
    root = ensure_data_directories(data_dir)
    canonical_document_id = str(validate_uuid(document_id, "document_id"))
    staging_root = _require_within(root / ".staging", root, "Staging directory")
    staging_directory = Path(
        tempfile.mkdtemp(
            prefix=f"{canonical_document_id}-",
            dir=staging_root,
        )
    )
    return _require_within(staging_directory, staging_root, "Staging path")


def promote_staging_directory(
    staging_directory: Path | str,
    user_id: str | uuid.UUID,
    document_id: str | uuid.UUID,
    data_dir: Path | str | None = None,
) -> Path:
    """Atomically move one validated staging directory into its final location."""
    root = ensure_data_directories(data_dir)
    staging_root = _require_within(root / ".staging", root, "Staging directory")
    canonical_document_id = str(validate_uuid(document_id, "document_id"))
    validated_staging = _require_within(
        Path(staging_directory),
        staging_root,
        "Staging path",
    )
    if validated_staging.parent != staging_root:
        raise ValueError("Staging directory must be a direct child of .staging.")
    if not validated_staging.name.startswith(f"{canonical_document_id}-"):
        raise ValueError("Staging directory does not belong to document_id.")
    if not validated_staging.is_dir() or validated_staging.is_symlink():
        raise ValueError("Staging directory must be a real directory.")

    final_directory = get_document_directory(user_id, document_id, root)
    final_directory.parent.mkdir(parents=True, exist_ok=True)
    if final_directory.exists():
        raise FileExistsError(f"Document directory already exists: {final_directory}")
    validated_staging.replace(final_directory)
    return final_directory


def remove_staging_directory(
    staging_directory: Path | str,
    data_dir: Path | str | None = None,
) -> None:
    """Remove one validated direct child of the staging directory."""
    root = ensure_data_directories(data_dir)
    staging_root = _require_within(root / ".staging", root, "Staging directory")
    validated_staging = _require_within(
        Path(staging_directory),
        staging_root,
        "Staging path",
    )
    if validated_staging.parent != staging_root:
        raise ValueError("Staging directory must be a direct child of .staging.")
    if validated_staging.exists():
        if validated_staging.is_symlink() or not validated_staging.is_dir():
            raise ValueError("Staging path must be a real directory.")
        shutil.rmtree(validated_staging)


def remove_document_directory(
    user_id: str | uuid.UUID,
    document_id: str | uuid.UUID,
    data_dir: Path | str | None = None,
) -> None:
    """Remove one validated final directory during ingestion compensation."""
    document_directory = get_document_directory(user_id, document_id, data_dir)
    if document_directory.exists():
        if document_directory.is_symlink() or not document_directory.is_dir():
            raise ValueError("Document path must be a real directory.")
        shutil.rmtree(document_directory)
