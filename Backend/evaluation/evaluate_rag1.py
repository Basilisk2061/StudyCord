"""Reproducible, local evaluation runner for the existing StudyCord RAG 1."""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import mimetypes
import os
import statistics
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Any, Awaitable, Callable, Protocol

from starlette.datastructures import Headers, UploadFile

from rag1.conversation import (
    RAG_CHAT_HISTORY_LIMIT,
    RAG_RETRIEVAL_K,
    build_contextualization_messages,
    build_grounded_answer_messages,
    generate_grounded_answer,
    usable_retrieval_query,
)
from rag1.ingestion import (
    CHUNK_OVERLAP,
    CHUNK_SIZE,
    EMBEDDING_MODEL,
    ingest_rag_document,
)
from rag1.service import resolve_rag_document


QUALITY_METRICS = (
    "faithfulness",
    "answer_relevancy",
    "context_precision",
    "context_recall",
)
GROUND_TRUTH_TYPES = {
    "manual",
    "synthetic",
    "synthetic_reviewed",
}
CSV_FIELDS = (
    "test_id",
    "document_id",
    "question",
    "reference_answer",
    "reference_contexts",
    "generated_answer",
    "retrieved_context_count",
    "retrieved_contexts",
    "faithfulness",
    "answer_relevancy",
    "context_precision",
    "context_recall",
    "contextualization_ms",
    "retrieval_ms",
    "generation_ms",
    "total_ms",
    "status",
    "error",
    "ground_truth_type",
    "history_message_count",
    "contextualization_used",
    "contextualization_fallback",
    "metric_errors",
)


class DatasetValidationError(ValueError):
    """Raised when an evaluation dataset is incomplete or unsafe."""


@dataclass(frozen=True)
class HistoryMessage:
    role: str
    content: str


@dataclass(frozen=True)
class EvaluationCase:
    id: str
    document_id: str
    question: str
    reference_answer: str
    history: tuple[HistoryMessage, ...] = ()
    reference_contexts: tuple[str, ...] = ()


@dataclass(frozen=True)
class EvaluationDataset:
    dataset_name: str
    ground_truth_type: str
    description: str
    cases: tuple[EvaluationCase, ...]


@dataclass(frozen=True)
class QueryTrace:
    generated_answer: str
    retrieved_contexts: list[str]
    retrieval_query: str
    contextualization_ms: float
    retrieval_ms: float
    generation_ms: float
    total_ms: float
    contextualization_used: bool
    contextualization_fallback: bool


@dataclass(frozen=True)
class IngestionTrace:
    filename: str
    document_id: str | None
    chunk_count: int | None
    total_ms: float
    status: str
    error: str


class MetricEvaluator(Protocol):
    async def score(
        self,
        case: EvaluationCase,
        response: str,
        retrieved_contexts: list[str],
    ) -> tuple[dict[str, float | None], dict[str, str]]: ...


def _required_text(value: Any, label: str, maximum: int = 20_000) -> str:
    if not isinstance(value, str) or not value.strip():
        raise DatasetValidationError(f"{label} must be a non-empty string.")
    result = value.strip()
    if len(result) > maximum:
        raise DatasetValidationError(
            f"{label} must be at most {maximum} characters."
        )
    return result


def _document_uuid(value: Any, label: str) -> str:
    text = _required_text(value, label, 100)
    try:
        return str(uuid.UUID(text))
    except (ValueError, AttributeError) as error:
        raise DatasetValidationError(f"{label} must be a UUID.") from error


def _load_history(raw_history: Any, case_label: str) -> tuple[HistoryMessage, ...]:
    if raw_history is None:
        return ()
    if not isinstance(raw_history, list):
        raise DatasetValidationError(f"{case_label}.history must be a list.")
    if len(raw_history) > RAG_CHAT_HISTORY_LIMIT:
        raise DatasetValidationError(
            f"{case_label}.history may contain at most "
            f"{RAG_CHAT_HISTORY_LIMIT} messages."
        )

    messages: list[HistoryMessage] = []
    for index, raw_message in enumerate(raw_history):
        if not isinstance(raw_message, dict):
            raise DatasetValidationError(
                f"{case_label}.history[{index}] must be an object."
            )
        if set(raw_message) != {"role", "content"}:
            raise DatasetValidationError(
                f"{case_label}.history[{index}] supports only role and content."
            )
        role = raw_message.get("role")
        if role not in {"user", "assistant"}:
            raise DatasetValidationError(
                f"{case_label}.history[{index}].role must be user or assistant."
            )
        messages.append(
            HistoryMessage(
                role=role,
                content=_required_text(
                    raw_message.get("content"),
                    f"{case_label}.history[{index}].content",
                    4_000,
                ),
            )
        )
    return tuple(messages)


def _load_reference_contexts(
    raw_contexts: Any,
    case_label: str,
) -> tuple[str, ...]:
    if raw_contexts is None:
        return ()
    if not isinstance(raw_contexts, list):
        raise DatasetValidationError(
            f"{case_label}.reference_contexts must be a list."
        )
    return tuple(
        _required_text(
            context,
            f"{case_label}.reference_contexts[{index}]",
            50_000,
        )
        for index, context in enumerate(raw_contexts)
    )


def load_dataset(path: str | Path) -> EvaluationDataset:
    dataset_path = Path(path)
    try:
        raw = json.loads(dataset_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise DatasetValidationError(
            "Evaluation dataset could not be read as UTF-8 JSON."
        ) from error

    if not isinstance(raw, dict):
        raise DatasetValidationError("Evaluation dataset must be an object.")
    allowed_top_level = {
        "dataset_name",
        "ground_truth_type",
        "description",
        "cases",
    }
    extra_fields = set(raw) - allowed_top_level
    if extra_fields:
        raise DatasetValidationError(
            "Unsupported dataset fields: " + ", ".join(sorted(extra_fields))
        )

    ground_truth_type = raw.get("ground_truth_type")
    if ground_truth_type not in GROUND_TRUTH_TYPES:
        raise DatasetValidationError(
            "ground_truth_type must be manual, synthetic, or synthetic_reviewed."
        )
    raw_cases = raw.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        raise DatasetValidationError(
            "Evaluation dataset must contain at least one case."
        )

    cases: list[EvaluationCase] = []
    seen_ids: set[str] = set()
    allowed_case_fields = {
        "id",
        "document_id",
        "question",
        "reference_answer",
        "history",
        "reference_contexts",
    }
    for index, raw_case in enumerate(raw_cases):
        case_label = f"cases[{index}]"
        if not isinstance(raw_case, dict):
            raise DatasetValidationError(f"{case_label} must be an object.")
        extras = set(raw_case) - allowed_case_fields
        if extras:
            raise DatasetValidationError(
                f"{case_label} has unsupported fields: "
                + ", ".join(sorted(extras))
            )
        case_id = _required_text(raw_case.get("id"), f"{case_label}.id", 100)
        if case_id in seen_ids:
            raise DatasetValidationError(f"Duplicate case id: {case_id}")
        seen_ids.add(case_id)
        cases.append(
            EvaluationCase(
                id=case_id,
                document_id=_document_uuid(
                    raw_case.get("document_id"),
                    f"{case_label}.document_id",
                ),
                question=_required_text(
                    raw_case.get("question"),
                    f"{case_label}.question",
                    4_000,
                ),
                reference_answer=_required_text(
                    raw_case.get("reference_answer"),
                    f"{case_label}.reference_answer",
                    20_000,
                ),
                history=_load_history(raw_case.get("history"), case_label),
                reference_contexts=_load_reference_contexts(
                    raw_case.get("reference_contexts"),
                    case_label,
                ),
            )
        )

    return EvaluationDataset(
        dataset_name=_required_text(
            raw.get("dataset_name"),
            "dataset_name",
            200,
        ),
        ground_truth_type=ground_truth_type,
        description=_required_text(
            raw.get("description", "No description provided."),
            "description",
            2_000,
        ),
        cases=tuple(cases),
    )


def _default_model_factory(temperature: float):
    # Importing here keeps framework-only tests independent of backend startup.
    from main import get_rag_chat_model

    return get_rag_chat_model(temperature=temperature)


async def run_rag1_query(
    case: EvaluationCase,
    user_id: str,
    *,
    model_factory: Callable[[float], Any] = _default_model_factory,
    document_resolver: Callable[[str, str], Any] = resolve_rag_document,
    clock: Callable[[], float] = perf_counter,
) -> QueryTrace:
    """Execute the current RAG 1 query path without its generation cache."""
    total_started = clock()
    document = document_resolver(user_id, case.document_id)
    retrieval_query = case.question
    contextualization_ms = 0.0
    contextualization_used = False
    contextualization_fallback = False

    if case.history:
        contextualization_started = clock()
        try:
            contextualizer = model_factory(0)
            rewrite_response = await contextualizer.ainvoke(
                build_contextualization_messages(
                    case.history,
                    case.question,
                )
            )
            rewritten = usable_retrieval_query(rewrite_response.content)
            if rewritten is None:
                contextualization_fallback = True
            else:
                retrieval_query = rewritten
                contextualization_used = True
        except Exception:
            contextualization_fallback = True
        contextualization_ms = (clock() - contextualization_started) * 1_000

    retrieval_started = clock()
    documents = document.vector_store.similarity_search(
        retrieval_query,
        k=RAG_RETRIEVAL_K,
    )
    retrieval_ms = (clock() - retrieval_started) * 1_000
    contexts = [item.page_content for item in documents]

    generation_started = clock()
    answer_model = model_factory(0.3)
    generated_answer = await generate_grounded_answer(
        answer_model,
        build_grounded_answer_messages(
            "\n\n".join(contexts),
            case.history,
            case.question,
        ),
    )
    generation_ms = (clock() - generation_started) * 1_000

    return QueryTrace(
        generated_answer=generated_answer,
        retrieved_contexts=contexts,
        retrieval_query=retrieval_query,
        contextualization_ms=contextualization_ms,
        retrieval_ms=retrieval_ms,
        generation_ms=generation_ms,
        total_ms=(clock() - total_started) * 1_000,
        contextualization_used=contextualization_used,
        contextualization_fallback=contextualization_fallback,
    )


class RagasMetricEvaluator:
    """RAGAS 0.4 collections metrics with explicit evaluator providers."""

    def __init__(self):
        try:
            from google import genai
            from openai import AsyncOpenAI
            from ragas.embeddings import GoogleEmbeddings
            from ragas.llms import llm_factory
            from ragas.metrics.collections import (
                AnswerRelevancy,
                ContextPrecision,
                ContextRecall,
                Faithfulness,
            )
        except ImportError as error:
            raise RuntimeError(
                "RAGAS evaluation dependencies are missing. Install "
                "Backend/evaluation/requirements.txt in the backend environment."
            ) from error

        openrouter_key = os.getenv("OPENROUTER_API_KEY")
        google_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        if not openrouter_key or not google_key:
            raise RuntimeError(
                "OPENROUTER_API_KEY and GOOGLE_API_KEY/GEMINI_API_KEY are "
                "required for quality evaluation."
            )
        evaluator_model = os.getenv(
            "RAGAS_EVALUATOR_MODEL",
            os.getenv("OPENROUTER_MODEL", "openrouter/auto"),
        )
        openrouter_client = AsyncOpenAI(
            api_key=openrouter_key,
            base_url="https://openrouter.ai/api/v1",
            timeout=120,
            max_retries=2,
        )
        evaluator_llm = llm_factory(
            evaluator_model,
            provider="openai",
            client=openrouter_client,
            temperature=0,
        )
        google_client = genai.Client(api_key=google_key)
        evaluator_embeddings = GoogleEmbeddings(
            client=google_client,
            model="gemini-embedding-001",
        )
        self.metrics = {
            "faithfulness": Faithfulness(llm=evaluator_llm),
            "answer_relevancy": AnswerRelevancy(
                llm=evaluator_llm,
                embeddings=evaluator_embeddings,
            ),
            "context_precision": ContextPrecision(llm=evaluator_llm),
            "context_recall": ContextRecall(llm=evaluator_llm),
        }

    async def score(
        self,
        case: EvaluationCase,
        response: str,
        retrieved_contexts: list[str],
    ) -> tuple[dict[str, float | None], dict[str, str]]:
        arguments = {
            "faithfulness": {
                "response": response,
                "retrieved_contexts": retrieved_contexts,
            },
            "answer_relevancy": {
                "user_input": case.question,
                "response": response,
            },
            "context_precision": {
                "user_input": case.question,
                "response": response,
                "retrieved_contexts": retrieved_contexts,
                "reference": case.reference_answer,
            },
            "context_recall": {
                "user_input": case.question,
                "retrieved_contexts": retrieved_contexts,
                "reference": case.reference_answer,
            },
        }
        scores: dict[str, float | None] = {}
        errors: dict[str, str] = {}
        for name in QUALITY_METRICS:
            try:
                result = await self.metrics[name].ascore(**arguments[name])
                scores[name] = float(result.value)
            except Exception as error:
                scores[name] = None
                errors[name] = type(error).__name__
        return scores, errors


def _failed_row(case: EvaluationCase, ground_truth_type: str) -> dict[str, Any]:
    return {
        "test_id": case.id,
        "document_id": case.document_id,
        "question": case.question,
        "reference_answer": case.reference_answer,
        "reference_contexts": list(case.reference_contexts),
        "generated_answer": "",
        "retrieved_context_count": 0,
        "retrieved_contexts": [],
        **{name: None for name in QUALITY_METRICS},
        "contextualization_ms": None,
        "retrieval_ms": None,
        "generation_ms": None,
        "total_ms": None,
        "status": "failed",
        "error": "",
        "ground_truth_type": ground_truth_type,
        "history_message_count": len(case.history),
        "contextualization_used": False,
        "contextualization_fallback": False,
        "metric_errors": {},
    }


async def evaluate_dataset(
    dataset: EvaluationDataset,
    user_id: str,
    *,
    query_runner: Callable[
        [EvaluationCase, str], Awaitable[QueryTrace]
    ] = run_rag1_query,
    metric_evaluator: MetricEvaluator | None = None,
    clock: Callable[[], float] = perf_counter,
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for case in dataset.cases:
        row = _failed_row(case, dataset.ground_truth_type)
        started = clock()
        try:
            trace = await query_runner(case, user_id)
            row.update(
                {
                    "generated_answer": trace.generated_answer,
                    "retrieved_context_count": len(trace.retrieved_contexts),
                    "retrieved_contexts": trace.retrieved_contexts,
                    "contextualization_ms": trace.contextualization_ms,
                    "retrieval_ms": trace.retrieval_ms,
                    "generation_ms": trace.generation_ms,
                    "total_ms": trace.total_ms,
                    "status": "success",
                    "contextualization_used": trace.contextualization_used,
                    "contextualization_fallback": (
                        trace.contextualization_fallback
                    ),
                }
            )
            if metric_evaluator is not None:
                scores, metric_errors = await metric_evaluator.score(
                    case,
                    trace.generated_answer,
                    trace.retrieved_contexts,
                )
                row.update(scores)
                row["metric_errors"] = metric_errors
        except Exception as error:
            row["total_ms"] = (clock() - started) * 1_000
            row["error"] = type(error).__name__
        results.append(row)

    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset": {
            "name": dataset.dataset_name,
            "description": dataset.description,
            "ground_truth_type": dataset.ground_truth_type,
        },
        "pipeline": {
            "chunk_size": CHUNK_SIZE,
            "chunk_overlap": CHUNK_OVERLAP,
            "embedding_model": EMBEDDING_MODEL,
            "retrieval_k": RAG_RETRIEVAL_K,
            "generation_provider": "OpenRouter",
            "generation_model": os.getenv(
                "OPENROUTER_MODEL",
                "openrouter/auto",
            ),
            "quality_framework": "ragas==0.4.3",
            "quality_evaluator_model": os.getenv(
                "RAGAS_EVALUATOR_MODEL",
                os.getenv("OPENROUTER_MODEL", "openrouter/auto"),
            ),
        },
        "results": results,
        "aggregates": calculate_aggregates(results),
    }


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * percentile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def _numeric_summary(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {
            "count": 0,
            "mean": None,
            "median": None,
            "minimum": None,
            "maximum": None,
            "p95": None,
        }
    return {
        "count": len(values),
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "minimum": min(values),
        "maximum": max(values),
        "p95": _percentile(values, 0.95),
    }


def calculate_aggregates(results: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(results)
    successful = sum(row.get("status") == "success" for row in results)
    quality = {
        name: _numeric_summary(
            [
                float(row[name])
                for row in results
                if isinstance(row.get(name), (int, float))
            ]
        )
        for name in QUALITY_METRICS
    }
    latency_fields = (
        "contextualization_ms",
        "retrieval_ms",
        "generation_ms",
        "total_ms",
    )
    latency = {
        name: _numeric_summary(
            [
                float(row[name])
                for row in results
                if row.get("status") == "success"
                and isinstance(row.get(name), (int, float))
            ]
        )
        for name in latency_fields
    }
    return {
        "reliability": {
            "total_tests": total,
            "successful_tests": successful,
            "failed_tests": total - successful,
            "success_percentage": (
                successful / total * 100 if total else 0.0
            ),
        },
        "quality": quality,
        "latency_ms": latency,
    }


def calculate_ingestion_aggregates(
    results: list[dict[str, Any]],
) -> dict[str, Any]:
    successful = [
        row for row in results if row.get("status") == "success"
    ]
    return {
        "total_documents": len(results),
        "successful_documents": len(successful),
        "failed_documents": len(results) - len(successful),
        "total_ingestion_ms": _numeric_summary(
            [
                float(row["total_ms"])
                for row in successful
                if isinstance(row.get("total_ms"), (int, float))
            ]
        ),
    }


def write_results(
    report: dict[str, Any],
    results_directory: str | Path,
) -> tuple[Path, Path]:
    output_directory = Path(results_directory)
    output_directory.mkdir(parents=True, exist_ok=True)
    json_path = output_directory / "rag1_evaluation.json"
    csv_path = output_directory / "rag1_evaluation.csv"
    json_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for source_row in report["results"]:
            row = dict(source_row)
            row["retrieved_contexts"] = json.dumps(
                row.get("retrieved_contexts", []),
                ensure_ascii=False,
            )
            row["reference_contexts"] = json.dumps(
                row.get("reference_contexts", []),
                ensure_ascii=False,
            )
            row["metric_errors"] = json.dumps(
                row.get("metric_errors", {}),
                sort_keys=True,
            )
            writer.writerow({field: row.get(field) for field in CSV_FIELDS})
    return json_path, csv_path


async def measure_ingestion(
    document_path: str | Path,
    user_id: str,
    *,
    ingestion_function: Callable[..., Awaitable[Any]] = ingest_rag_document,
    clock: Callable[[], float] = perf_counter,
) -> IngestionTrace:
    """Measure total production ingestion without exposing the source path."""
    path = Path(document_path)
    started = clock()
    upload: UploadFile | None = None
    try:
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        handle = path.open("rb")
        upload = UploadFile(
            file=handle,
            filename=path.name,
            headers=Headers({"content-type": mime_type}),
        )
        result = await ingestion_function(upload, user_id)
        return IngestionTrace(
            filename=path.name,
            document_id=result.doc_id,
            chunk_count=result.chunk_count,
            total_ms=(clock() - started) * 1_000,
            status="success",
            error="",
        )
    except Exception as error:
        return IngestionTrace(
            filename=path.name,
            document_id=None,
            chunk_count=None,
            total_ms=(clock() - started) * 1_000,
            status="failed",
            error=type(error).__name__,
        )
    finally:
        if upload is not None:
            try:
                await upload.close()
            except Exception:
                pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Evaluate the existing StudyCord RAG 1 pipeline.",
    )
    parser.add_argument("--dataset", type=Path)
    parser.add_argument("--user-id", required=True)
    parser.add_argument(
        "--results-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "results",
    )
    parser.add_argument(
        "--skip-quality",
        action="store_true",
        help="Collect pipeline outputs and latency without RAGAS calls.",
    )
    parser.add_argument(
        "--ingestion-file",
        action="append",
        default=[],
        type=Path,
        help="Optionally measure total production ingestion for a local document.",
    )
    parser.add_argument(
        "--rag1-data-dir",
        type=Path,
        help="Optional RAG1_DATA_DIR override; use an isolated evaluation workspace.",
    )
    return parser


async def _run_cli(arguments: argparse.Namespace) -> int:
    if arguments.rag1_data_dir:
        os.environ["RAG1_DATA_DIR"] = str(arguments.rag1_data_dir.resolve())
    if arguments.dataset is None and not arguments.ingestion_file:
        raise DatasetValidationError(
            "Provide --dataset, --ingestion-file, or both."
        )
    if arguments.dataset is not None:
        dataset = load_dataset(arguments.dataset)
        metric_evaluator = (
            None if arguments.skip_quality else RagasMetricEvaluator()
        )
        report = await evaluate_dataset(
            dataset,
            arguments.user_id,
            metric_evaluator=metric_evaluator,
        )
    else:
        report = {
            "schema_version": 1,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "dataset": None,
            "pipeline": {
                "chunk_size": CHUNK_SIZE,
                "chunk_overlap": CHUNK_OVERLAP,
                "embedding_model": EMBEDDING_MODEL,
                "retrieval_k": RAG_RETRIEVAL_K,
            },
            "results": [],
            "aggregates": calculate_aggregates([]),
        }
    ingestion_results = [
        asdict(await measure_ingestion(path, arguments.user_id))
        for path in arguments.ingestion_file
    ]
    report["ingestion"] = {
        "results": ingestion_results,
        "aggregates": calculate_ingestion_aggregates(ingestion_results),
    }
    json_path, csv_path = write_results(report, arguments.results_dir)
    reliability = report["aggregates"]["reliability"]
    print(
        "RAG 1 evaluation complete: "
        f"{reliability['successful_tests']}/{reliability['total_tests']} "
        f"queries succeeded."
    )
    print(f"JSON result: {json_path.name}")
    print(f"CSV result: {csv_path.name}")
    return 0 if reliability["failed_tests"] == 0 else 1


def main() -> int:
    return asyncio.run(_run_cli(_parser().parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
