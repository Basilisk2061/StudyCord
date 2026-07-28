"""Local persistence foundation for the personal RAG 1 Study Helper."""

from dataclasses import dataclass
from pathlib import Path

from .db import initialize_database
from .paths import ensure_data_directories, get_rag1_data_dir


@dataclass(frozen=True)
class Rag1Persistence:
    data_dir: Path
    database_path: Path


def initialize_rag1_persistence(data_dir: Path | str | None = None) -> Rag1Persistence:
    """Create the local RAG 1 directory structure and SQLite schema."""
    resolved_data_dir = get_rag1_data_dir(data_dir)
    ensure_data_directories(resolved_data_dir)
    database_path = initialize_database(resolved_data_dir)
    return Rag1Persistence(
        data_dir=resolved_data_dir,
        database_path=database_path,
    )


__all__ = ["Rag1Persistence", "initialize_rag1_persistence"]
