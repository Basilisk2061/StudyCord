"""Explicit, validated 768-dimensional Gemini embeddings for RAG 2."""

import math

from langchain_google_genai import GoogleGenerativeAIEmbeddings


EMBEDDING_MODEL = "models/gemini-embedding-001"
EMBEDDING_DIMENSIONS = 768
EMBEDDING_BATCH_SIZE = 100


class Rag2EmbeddingError(Exception):
    pass


def build_rag2_embeddings() -> GoogleGenerativeAIEmbeddings:
    return GoogleGenerativeAIEmbeddings(
        model=EMBEDDING_MODEL,
        output_dimensionality=EMBEDDING_DIMENSIONS,
    )


def normalize_embedding(values: list[float]) -> list[float]:
    if len(values) != EMBEDDING_DIMENSIONS:
        raise Rag2EmbeddingError(
            f"Embedding provider returned {len(values)} dimensions; "
            f"{EMBEDDING_DIMENSIONS} are required."
        )
    if not all(math.isfinite(value) for value in values):
        raise Rag2EmbeddingError("Embedding provider returned a non-finite value.")
    norm = math.sqrt(sum(value * value for value in values))
    if not math.isfinite(norm) or norm <= 0:
        raise Rag2EmbeddingError("Embedding provider returned a zero-length vector.")
    return [value / norm for value in values]


async def embed_document_chunks(
    chunks: list[str],
    *,
    embeddings: GoogleGenerativeAIEmbeddings | None = None,
) -> list[list[float]]:
    if not chunks:
        raise Rag2EmbeddingError("At least one chunk is required.")
    embeddings = embeddings or build_rag2_embeddings()
    try:
        vectors = await embeddings.aembed_documents(
            chunks,
            batch_size=EMBEDDING_BATCH_SIZE,
            task_type="RETRIEVAL_DOCUMENT",
            output_dimensionality=EMBEDDING_DIMENSIONS,
        )
    except Exception as error:
        raise Rag2EmbeddingError("Document embeddings could not be generated.") from error
    if len(vectors) != len(chunks):
        raise Rag2EmbeddingError(
            "Embedding provider returned a different number of vectors than chunks."
        )
    return [normalize_embedding(list(vector)) for vector in vectors]


async def embed_search_query(
    query: str,
    *,
    embeddings: GoogleGenerativeAIEmbeddings | None = None,
) -> list[float]:
    """Create one normalized RETRIEVAL_QUERY vector without altering documents."""
    normalized_query = query.strip()
    if not normalized_query:
        raise Rag2EmbeddingError("A non-empty search query is required.")
    try:
        embeddings = embeddings or build_rag2_embeddings()
        vector = await embeddings.aembed_query(
            normalized_query,
            task_type="RETRIEVAL_QUERY",
            output_dimensionality=EMBEDDING_DIMENSIONS,
        )
        return normalize_embedding(list(vector))
    except Rag2EmbeddingError:
        raise
    except Exception as error:
        raise Rag2EmbeddingError("Search query embedding could not be generated.") from error
