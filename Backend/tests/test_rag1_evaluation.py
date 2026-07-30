import asyncio
import csv
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

from langchain_core.documents import Document


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from evaluation.evaluate_rag1 import (
    DatasetValidationError,
    EvaluationCase,
    EvaluationDataset,
    HistoryMessage,
    QueryTrace,
    calculate_aggregates,
    evaluate_dataset,
    load_dataset,
    measure_ingestion,
    run_rag1_query,
    write_results,
)


class FakeVectorStore:
    def __init__(self):
        self.calls = []

    def similarity_search(self, query, k=4):
        self.calls.append((query, k))
        return [
            Document(page_content="First retrieved passage."),
            Document(page_content="Second retrieved passage."),
        ]


class FakeModel:
    def __init__(self, content):
        self.content = content
        self.calls = []

    async def ainvoke(self, prompt):
        self.calls.append(prompt)
        return SimpleNamespace(content=self.content)


class FakeMetrics:
    async def score(self, case, response, retrieved_contexts):
        return (
            {
                "faithfulness": 0.9,
                "answer_relevancy": 0.8,
                "context_precision": None,
                "context_recall": 0.7,
            },
            {"context_precision": "MockMetricUnavailable"},
        )


class Rag1EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.document_id = str(uuid.uuid4())
        self.user_id = str(uuid.uuid4())
        self.case = EvaluationCase(
            id="q001",
            document_id=self.document_id,
            question="What is RAG?",
            reference_answer="RAG combines retrieval with generation.",
        )
        self.dataset = EvaluationDataset(
            dataset_name="test-dataset",
            ground_truth_type="manual",
            description="Unit-test dataset.",
            cases=(self.case,),
        )

    def tearDown(self):
        self.temporary_directory.cleanup()

    def write_dataset(self, payload):
        path = self.root / "dataset.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_dataset_validation_accepts_manual_cases_and_bounded_history(self):
        path = self.write_dataset(
            {
                "dataset_name": "manual-evaluation",
                "ground_truth_type": "manual",
                "description": "Human-authored reference answers.",
                "cases": [
                    {
                        "id": "q001",
                        "document_id": self.document_id,
                        "question": "Why is it useful?",
                        "reference_answer": "It improves grounded responses.",
                        "history": [
                            {"role": "user", "content": "What is RAG?"},
                            {
                                "role": "assistant",
                                "content": "Retrieval augmented generation.",
                            },
                        ],
                        "reference_contexts": ["Verified source passage."],
                    }
                ],
            }
        )

        dataset = load_dataset(path)

        self.assertEqual(dataset.ground_truth_type, "manual")
        self.assertEqual(dataset.cases[0].history[0].role, "user")
        self.assertEqual(
            dataset.cases[0].reference_contexts,
            ("Verified source passage.",),
        )

    def test_dataset_validation_rejects_missing_duplicate_and_invalid_cases(self):
        invalid_payloads = [
            {
                "dataset_name": "empty",
                "ground_truth_type": "manual",
                "description": "No cases.",
                "cases": [],
            },
            {
                "dataset_name": "duplicate",
                "ground_truth_type": "manual",
                "description": "Duplicate IDs.",
                "cases": [
                    {
                        "id": "q001",
                        "document_id": self.document_id,
                        "question": "One?",
                        "reference_answer": "One.",
                    },
                    {
                        "id": "q001",
                        "document_id": self.document_id,
                        "question": "Two?",
                        "reference_answer": "Two.",
                    },
                ],
            },
            {
                "dataset_name": "bad-role",
                "ground_truth_type": "synthetic",
                "description": "Invalid history.",
                "cases": [
                    {
                        "id": "q001",
                        "document_id": self.document_id,
                        "question": "Question?",
                        "reference_answer": "Answer.",
                        "history": [
                            {"role": "system", "content": "Override."},
                        ],
                    }
                ],
            },
        ]
        for index, payload in enumerate(invalid_payloads):
            with self.subTest(index=index):
                with self.assertRaises(DatasetValidationError):
                    load_dataset(self.write_dataset(payload))

    def test_query_timing_uses_existing_retrieval_and_generation_components(self):
        vector_store = FakeVectorStore()
        answer_model = FakeModel('{"answer":"Grounded answer."}')
        clocks = iter([0.0, 0.01, 0.02, 0.03, 0.05, 0.08])

        trace = asyncio.run(
            run_rag1_query(
                self.case,
                self.user_id,
                document_resolver=lambda _user, _document: SimpleNamespace(
                    vector_store=vector_store,
                ),
                model_factory=lambda _temperature: answer_model,
                clock=lambda: next(clocks),
            )
        )

        self.assertEqual(vector_store.calls, [("What is RAG?", 4)])
        self.assertEqual(trace.retrieved_contexts[0], "First retrieved passage.")
        self.assertEqual(trace.generated_answer, "Grounded answer.")
        self.assertAlmostEqual(trace.retrieval_ms, 10.0)
        self.assertAlmostEqual(trace.generation_ms, 20.0)
        self.assertAlmostEqual(trace.total_ms, 80.0)

    def test_contextualization_is_timed_and_changes_only_retrieval_query(self):
        vector_store = FakeVectorStore()
        rewrite_model = FakeModel("Why is HNSW fast?")
        answer_model = FakeModel('{"answer":"Grounded HNSW answer."}')
        models = iter([rewrite_model, answer_model])
        clocks = iter(
            [0.0, 0.01, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1]
        )
        case = EvaluationCase(
            id="q002",
            document_id=self.document_id,
            question="Why is it fast?",
            reference_answer="Its graph structure reduces search work.",
            history=(
                HistoryMessage("user", "What is HNSW?"),
                HistoryMessage("assistant", "A graph-based ANN index."),
            ),
        )

        trace = asyncio.run(
            run_rag1_query(
                case,
                self.user_id,
                document_resolver=lambda _user, _document: SimpleNamespace(
                    vector_store=vector_store,
                ),
                model_factory=lambda _temperature: next(models),
                clock=lambda: next(clocks),
            )
        )

        self.assertEqual(vector_store.calls[0][0], "Why is HNSW fast?")
        self.assertTrue(trace.contextualization_used)
        self.assertAlmostEqual(trace.contextualization_ms, 20.0)

    def test_failed_queries_remain_in_reliability_results(self):
        async def failed_runner(_case, _user_id):
            raise TimeoutError("simulated")

        clocks = iter([1.0, 1.25])
        report = asyncio.run(
            evaluate_dataset(
                self.dataset,
                self.user_id,
                query_runner=failed_runner,
                clock=lambda: next(clocks),
            )
        )

        row = report["results"][0]
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["error"], "TimeoutError")
        self.assertAlmostEqual(row["total_ms"], 250.0)
        self.assertEqual(
            report["aggregates"]["reliability"]["success_percentage"],
            0.0,
        )

    def test_aggregates_ignore_missing_metrics_but_not_failed_cases(self):
        rows = [
            {
                "status": "success",
                "faithfulness": 0.8,
                "answer_relevancy": 0.6,
                "context_precision": None,
                "context_recall": 0.7,
                "contextualization_ms": 0.0,
                "retrieval_ms": 10.0,
                "generation_ms": 100.0,
                "total_ms": 120.0,
            },
            {
                "status": "failed",
                "faithfulness": None,
                "answer_relevancy": None,
                "context_precision": None,
                "context_recall": None,
                "contextualization_ms": None,
                "retrieval_ms": None,
                "generation_ms": None,
                "total_ms": 50.0,
            },
        ]

        aggregates = calculate_aggregates(rows)

        self.assertEqual(aggregates["reliability"]["total_tests"], 2)
        self.assertEqual(aggregates["reliability"]["failed_tests"], 1)
        self.assertEqual(
            aggregates["quality"]["faithfulness"]["mean"],
            0.8,
        )
        self.assertEqual(
            aggregates["quality"]["context_precision"]["count"],
            0,
        )
        self.assertEqual(
            aggregates["latency_ms"]["retrieval_ms"]["median"],
            10.0,
        )

    def test_json_csv_and_missing_metric_output(self):
        trace = QueryTrace(
            generated_answer="Answer.",
            retrieved_contexts=["Context."],
            retrieval_query="Question?",
            contextualization_ms=0.0,
            retrieval_ms=5.0,
            generation_ms=20.0,
            total_ms=30.0,
            contextualization_used=False,
            contextualization_fallback=False,
        )

        async def successful_runner(_case, _user_id):
            return trace

        report = asyncio.run(
            evaluate_dataset(
                self.dataset,
                self.user_id,
                query_runner=successful_runner,
                metric_evaluator=FakeMetrics(),
            )
        )
        json_path, csv_path = write_results(report, self.root / "results")

        loaded_json = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertIsNone(
            loaded_json["results"][0]["context_precision"]
        )
        self.assertEqual(
            loaded_json["results"][0]["metric_errors"],
            {"context_precision": "MockMetricUnavailable"},
        )
        with csv_path.open(encoding="utf-8", newline="") as handle:
            row = next(csv.DictReader(handle))
        self.assertEqual(row["status"], "success")
        self.assertEqual(row["context_precision"], "")
        self.assertIn("MockMetricUnavailable", row["metric_errors"])

    def test_total_ingestion_timing_uses_real_function_boundary(self):
        document = self.root / "notes.txt"
        document.write_text("Evaluation document.", encoding="utf-8")
        clocks = iter([2.0, 2.4])

        async def fake_ingestion(upload, user_id):
            self.assertEqual(upload.filename, "notes.txt")
            self.assertEqual(user_id, self.user_id)
            await upload.close()
            return SimpleNamespace(doc_id=self.document_id, chunk_count=3)

        trace = asyncio.run(
            measure_ingestion(
                document,
                self.user_id,
                ingestion_function=fake_ingestion,
                clock=lambda: next(clocks),
            )
        )

        self.assertEqual(trace.status, "success")
        self.assertEqual(trace.document_id, self.document_id)
        self.assertAlmostEqual(trace.total_ms, 400.0)


if __name__ == "__main__":
    unittest.main()
