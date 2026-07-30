import asyncio
import io
import math
import re
import sys
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from rag2.document_processing import (
    CHUNK_OVERLAP,
    CHUNK_SIZE,
    MAX_CHUNKS,
    MAX_RESOURCE_BYTES,
    Rag2DocumentError,
    process_resource_document,
)
from rag2.embeddings import (
    EMBEDDING_BATCH_SIZE,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    Rag2EmbeddingError,
    build_rag2_embeddings,
    embed_document_chunks,
    normalize_embedding,
)
from rag2.indexing import (
    AuthorizedResource,
    IndexingResult,
    Rag2IndexingError,
    has_safe_canonical_storage_path,
    index_authorized_resource,
    resolve_authorized_resource,
)


MIGRATION_PATH = (
    BACKEND_DIR
    / "migrations"
    / "20260730_phase18_2_rag2_resource_indexing.sql"
)


class FakeEmbeddings:
    def __init__(self, *, vectors=None, error=None):
        self.vectors = vectors
        self.error = error
        self.calls = []

    async def aembed_documents(self, chunks, **kwargs):
        self.calls.append((chunks, kwargs))
        if self.error:
            raise self.error
        return self.vectors or [
            [1.0] + [0.0] * (EMBEDDING_DIMENSIONS - 1)
            for _ in chunks
        ]


class FakeTrustedClient:
    def __init__(self, content=b"Indexable server notes.", *, fail_on=None):
        self.content = content
        self.fail_on = fail_on
        self.calls = []
        self.attempt_id = str(uuid.uuid4())

    async def rpc(self, function_name, payload):
        self.calls.append(("rpc", function_name, payload))
        if self.fail_on == function_name:
            raise RuntimeError(f"database failure in {function_name}")
        if function_name == "begin_rag2_resource_indexing":
            return self.attempt_id
        if function_name == "complete_rag2_resource_indexing":
            return "2026-07-30T00:00:00+00:00"
        return 1

    async def storage_download(self, bucket, path, *, max_bytes):
        self.calls.append(("download", bucket, path, max_bytes))
        if self.fail_on == "storage":
            raise RuntimeError("Storage download failed with status 404.")
        return self.content


class FakeCallerClient:
    def __init__(self, resource, role="member"):
        self.resource = resource
        self.role = role
        self.calls = []

    async def rest(
        self,
        method,
        path,
        *,
        params=None,
        json_body=None,
        prefer=None,
    ):
        self.calls.append((method, path, params))
        if path == "server_resources":
            return [self.resource] if self.resource else []
        if path == "server_members":
            return [{"role": self.role}] if self.role else []
        raise AssertionError(path)


def make_resource(**overrides):
    row = {
        "id": str(uuid.uuid4()),
        "server_id": str(uuid.uuid4()),
        "uploader_id": str(uuid.uuid4()),
        "original_filename": "notes.txt",
        "storage_bucket": "channel-files",
        "storage_path": "server/channel/user/notes.txt",
        "visibility": "server",
        "index_status": "unindexed",
        "index_started_at": None,
    }
    row.update(overrides)
    return row


class Rag2MigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = MIGRATION_PATH.read_text(encoding="utf-8").lower()

    def test_pgvector_and_vector_768_without_hnsw(self):
        self.assertIn(
            "create extension if not exists vector with schema extensions",
            self.sql,
        )
        self.assertIn("embedding extensions.vector(768) not null", self.sql)
        self.assertNotIn("using hnsw", self.sql)
        self.assertNotIn("using ivfflat", self.sql)

    def test_resource_chunks_constraints_and_same_server_cascade(self):
        self.assertIn("create table public.resource_chunks", self.sql)
        self.assertIn("foreign key (resource_id, server_id)", self.sql)
        self.assertIn("references public.server_resources(id, server_id)", self.sql)
        self.assertIn("on delete cascade", self.sql)
        self.assertIn(
            "unique (resource_id, index_attempt_id, chunk_index)",
            self.sql,
        )
        self.assertIn("char_length(btrim(content)) > 0", self.sql)
        self.assertIsNone(
            re.search(r"char_length\(content\)\s*<=\s*1000(?!0)", self.sql)
        )

    def test_lifecycle_attempts_and_atomic_completion_are_backend_only(self):
        for name in (
            "begin_rag2_resource_indexing",
            "stage_rag2_resource_chunks",
            "complete_rag2_resource_indexing",
            "fail_rag2_resource_indexing",
        ):
            self.assertIn(name, self.sql)
        self.assertIn("index_attempt_id = p_attempt_id", self.sql)
        self.assertIn("v_min_index <> 0", self.sql)
        self.assertIn("v_max_index <> p_expected_chunk_count - 1", self.sql)
        self.assertIn("index_status = 'ready'", self.sql)
        self.assertIn("interval '30 minutes'", self.sql)
        self.assertIn("to service_role", self.sql)
        self.assertIn(
            "revoke all on table public.resource_chunks from public, anon, authenticated",
            self.sql,
        )
        self.assertNotIn("to authenticated;\n\ngrant execute", self.sql)

    def test_migration_has_no_backfill_search_or_later_phase_objects(self):
        self.assertNotIn("resource_ratings", self.sql)
        self.assertNotIn("match_resources", self.sql)
        self.assertNotIn("query_embedding", self.sql)
        self.assertNotIn("message_attachments\n  set resource_id", self.sql)


class Rag2DocumentProcessingTests(unittest.TestCase):
    def test_txt_validation_is_strict_and_chunking_is_1000_200(self):
        text = ("academic material " * 200).encode()
        result = process_resource_document("notes.txt", text)
        self.assertEqual(result.detected_type, "txt")
        self.assertGreater(len(result.chunks), 1)
        self.assertEqual(CHUNK_SIZE, 1000)
        self.assertEqual(CHUNK_OVERLAP, 200)
        self.assertTrue(all(chunk.strip() for chunk in result.chunks))

    def test_txt_rejects_nul_invalid_utf8_empty_and_oversize(self):
        cases = (
            ("notes.txt", b"a\x00b", 422),
            ("notes.txt", b"\xff\xfe\xfd", 422),
            ("notes.txt", b" \r\n\t ", 422),
            ("notes.txt", b"a" * (MAX_RESOURCE_BYTES + 1), 413),
        )
        for filename, content, status in cases:
            with self.subTest(status=status):
                with self.assertRaises(Rag2DocumentError) as raised:
                    process_resource_document(filename, content)
                self.assertEqual(raised.exception.status_code, status)

    def test_pdf_signature_parser_and_nonempty_text(self):
        class Page:
            def extract_text(self):
                return "PDF academic content"

        class Reader:
            is_encrypted = False
            pages = [Page()]

        with patch("pypdf.PdfReader", return_value=Reader()):
            result = process_resource_document(
                "paper.pdf",
                b"%PDF-1.7\nsynthetic",
            )
        self.assertEqual(result.detected_type, "pdf")
        self.assertEqual(result.text, "PDF academic content")

    def test_docx_structure_and_extraction(self):
        import docx

        buffer = io.BytesIO()
        document = docx.Document()
        document.add_paragraph("DOCX academic content")
        document.save(buffer)
        result = process_resource_document("paper.docx", buffer.getvalue())
        self.assertEqual(result.detected_type, "docx")
        self.assertEqual(result.text, "DOCX academic content")

    def test_corrupt_and_renamed_documents_are_rejected_before_embedding(self):
        cases = (
            ("renamed.pdf", b"ordinary text"),
            ("renamed.txt", b"%PDF-1.7\nsynthetic"),
            ("broken.docx", b"PK\x03\x04not-a-valid-archive"),
        )
        for filename, content in cases:
            with self.subTest(filename=filename):
                with self.assertRaises(Rag2DocumentError):
                    process_resource_document(filename, content)

    def test_pdf_extraction_failure_is_rejected(self):
        class BrokenPage:
            def extract_text(self):
                raise ValueError("broken stream")

        class Reader:
            is_encrypted = False
            pages = [BrokenPage()]

        with (
            patch("pypdf.PdfReader", return_value=Reader()),
            self.assertRaises(Rag2DocumentError),
        ):
            process_resource_document("paper.pdf", b"%PDF-1.7\nsynthetic")

    def test_maximum_chunk_count_is_enforced(self):
        with patch(
            "rag2.document_processing.RecursiveCharacterTextSplitter.split_text",
            return_value=["chunk"] * (MAX_CHUNKS + 1),
        ):
            with self.assertRaises(Rag2DocumentError) as raised:
                process_resource_document("notes.txt", b"valid text")
        self.assertEqual(raised.exception.status_code, 413)


class Rag2EmbeddingTests(unittest.TestCase):
    def test_builder_explicitly_configures_768_dimensions(self):
        with patch(
            "rag2.embeddings.GoogleGenerativeAIEmbeddings"
        ) as constructor:
            build_rag2_embeddings()
        constructor.assert_called_once_with(
            model=EMBEDDING_MODEL,
            output_dimensionality=EMBEDDING_DIMENSIONS,
        )

    def test_embedding_call_uses_document_task_and_bounded_batch(self):
        fake = FakeEmbeddings()
        vectors = asyncio.run(
            embed_document_chunks(["one", "two"], embeddings=fake)
        )
        self.assertEqual(len(vectors), 2)
        chunks, kwargs = fake.calls[0]
        self.assertEqual(chunks, ["one", "two"])
        self.assertEqual(kwargs["batch_size"], EMBEDDING_BATCH_SIZE)
        self.assertEqual(kwargs["task_type"], "RETRIEVAL_DOCUMENT")
        self.assertEqual(kwargs["output_dimensionality"], 768)
        self.assertAlmostEqual(math.sqrt(sum(v * v for v in vectors[0])), 1.0)

    def test_embedding_validation_rejects_bad_dimension_nonfinite_and_zero(self):
        invalid = (
            [1.0],
            [float("nan")] + [0.0] * 767,
            [0.0] * 768,
        )
        for vector in invalid:
            with self.subTest(length=len(vector)):
                with self.assertRaises(Rag2EmbeddingError):
                    normalize_embedding(vector)

    def test_provider_failure_and_count_mismatch_are_controlled(self):
        with self.assertRaises(Rag2EmbeddingError):
            asyncio.run(
                embed_document_chunks(
                    ["one"],
                    embeddings=FakeEmbeddings(error=RuntimeError("provider")),
                )
            )
        with self.assertRaises(Rag2EmbeddingError):
            asyncio.run(
                embed_document_chunks(
                    ["one", "two"],
                    embeddings=FakeEmbeddings(vectors=[[1.0] + [0.0] * 767]),
                )
            )


class Rag2IndexingServiceTests(unittest.TestCase):
    def setUp(self):
        self.row = make_resource()
        self.resource = AuthorizedResource(**self.row)

    def test_caller_scoped_resolution_uses_only_canonical_database_fields(self):
        caller = FakeCallerClient(self.row)
        resource = asyncio.run(
            resolve_authorized_resource(caller, self.row["id"])
        )
        self.assertEqual(resource.storage_path, self.row["storage_path"])
        params = caller.calls[0][2]
        self.assertEqual(params["id"], f"eq.{self.row['id']}")
        self.assertNotIn("url", params["select"])

    def test_canonical_storage_paths_reject_traversal_and_backslashes(self):
        self.assertTrue(
            has_safe_canonical_storage_path("server/channel/user/file.pdf")
        )
        for path in (
            "../file.pdf",
            "server/../file.pdf",
            "/server/file.pdf",
            "server\\file.pdf",
            "server//file.pdf",
        ):
            with self.subTest(path=path):
                self.assertFalse(has_safe_canonical_storage_path(path))

    def test_success_stages_embeddings_then_completes_ready(self):
        trusted = FakeTrustedClient()
        result = asyncio.run(
            index_authorized_resource(
                self.resource,
                trusted,
                embeddings=FakeEmbeddings(),
            )
        )
        names = [call[1] for call in trusted.calls if call[0] == "rpc"]
        self.assertEqual(
            names,
            [
                "begin_rag2_resource_indexing",
                "stage_rag2_resource_chunks",
                "complete_rag2_resource_indexing",
            ],
        )
        download = next(call for call in trusted.calls if call[0] == "download")
        self.assertEqual(download[1:3], ("channel-files", self.row["storage_path"]))
        self.assertEqual(result.detected_type, "txt")
        self.assertEqual(result.chunk_count, 1)

    def test_validation_embedding_storage_and_database_failures_cleanup(self):
        scenarios = (
            (
                FakeTrustedClient(content=b"\x00binary"),
                FakeEmbeddings(),
                422,
            ),
            (
                FakeTrustedClient(),
                FakeEmbeddings(error=RuntimeError("provider")),
                502,
            ),
            (
                FakeTrustedClient(fail_on="storage"),
                FakeEmbeddings(),
                503,
            ),
            (
                FakeTrustedClient(fail_on="stage_rag2_resource_chunks"),
                FakeEmbeddings(),
                500,
            ),
        )
        for trusted, embeddings, status in scenarios:
            with self.subTest(status=status):
                with self.assertRaises(Rag2IndexingError) as raised:
                    asyncio.run(
                        index_authorized_resource(
                            self.resource,
                            trusted,
                            embeddings=embeddings,
                        )
                    )
                self.assertEqual(raised.exception.status_code, status)
                names = [
                    call[1]
                    for call in trusted.calls
                    if call[0] == "rpc"
                ]
                self.assertIn("fail_rag2_resource_indexing", names)

    def test_begin_concurrency_failure_has_no_failure_cleanup(self):
        trusted = FakeTrustedClient(fail_on="begin_rag2_resource_indexing")
        with self.assertRaises(Rag2IndexingError):
            asyncio.run(
                index_authorized_resource(
                    self.resource,
                    trusted,
                    embeddings=FakeEmbeddings(),
                )
            )
        names = [call[1] for call in trusted.calls if call[0] == "rpc"]
        self.assertNotIn("fail_rag2_resource_indexing", names)


class Rag2IndexingEndpointTests(unittest.TestCase):
    def setUp(self):
        self.user_id = str(uuid.uuid4())
        self.row = make_resource(uploader_id=self.user_id)

    def tearDown(self):
        main.app.dependency_overrides.clear()

    def authenticate(self, caller):
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": self.user_id,
            "email": None,
            "supabase_user": caller,
        }

    def successful_result(self):
        return IndexingResult(
            resource_id=self.row["id"],
            server_id=self.row["server_id"],
            detected_type="txt",
            chunk_count=1,
            indexed_at=datetime(2026, 7, 30, tzinfo=timezone.utc),
        )

    def test_unauthenticated_nonmember_and_ordinary_non_uploader_are_denied(self):
        with TestClient(main.app) as api:
            unauthenticated = api.post(
                f"/api/rag2/resources/{self.row['id']}/index"
            )
        self.assertEqual(unauthenticated.status_code, 401)

        for role, uploader in ((None, self.user_id), ("member", str(uuid.uuid4()))):
            row = make_resource(uploader_id=uploader)
            caller = FakeCallerClient(row, role=role)
            self.authenticate(caller)
            with patch("main.supabase_admin") as admin, TestClient(main.app) as api:
                response = api.post(f"/api/rag2/resources/{row['id']}/index")
            self.assertEqual(response.status_code, 403)
            admin.assert_not_called()

    def test_uploader_and_manager_are_allowed_after_caller_checks(self):
        cases = (
            ("member", self.user_id),
            ("admin", str(uuid.uuid4())),
            ("owner", str(uuid.uuid4())),
        )
        for role, uploader in cases:
            with self.subTest(role=role):
                self.row = make_resource(uploader_id=uploader)
                caller = FakeCallerClient(self.row, role=role)
                self.authenticate(caller)
                trusted = object()
                result = self.successful_result()
                with (
                    patch("main.supabase_admin", return_value=trusted) as admin,
                    patch(
                        "main.index_authorized_resource",
                        new=AsyncMock(return_value=result),
                    ) as indexer,
                    TestClient(main.app) as api,
                ):
                    response = api.post(
                        f"/api/rag2/resources/{self.row['id']}/index"
                    )
                self.assertEqual(response.status_code, 200, response.text)
                admin.assert_called_once()
                indexer.assert_awaited_once()
                self.assertEqual(response.json()["embedding_dimensions"], 768)

    def test_private_wrong_bucket_ready_active_and_cross_server_are_denied_pre_service(self):
        active_time = datetime.now(timezone.utc).isoformat()
        cases = (
            ({"visibility": "private"}, 422),
            ({"storage_bucket": "other"}, 422),
            ({"index_status": "ready"}, 409),
            (
                {
                    "index_status": "processing",
                    "index_started_at": active_time,
                },
                409,
            ),
        )
        for overrides, expected in cases:
            with self.subTest(overrides=overrides):
                row = make_resource(uploader_id=self.user_id, **overrides)
                caller = FakeCallerClient(row, role="member")
                self.authenticate(caller)
                with patch("main.supabase_admin") as admin, TestClient(main.app) as api:
                    response = api.post(f"/api/rag2/resources/{row['id']}/index")
                self.assertEqual(response.status_code, expected)
                admin.assert_not_called()

        row = make_resource(uploader_id=self.user_id)
        caller = FakeCallerClient(row, role=None)
        self.authenticate(caller)
        with patch("main.supabase_admin") as admin, TestClient(main.app) as api:
            response = api.post(f"/api/rag2/resources/{row['id']}/index")
        self.assertEqual(response.status_code, 403)
        admin.assert_not_called()

    def test_stale_processing_attempt_may_reach_backend_recovery(self):
        self.row = make_resource(
            uploader_id=self.user_id,
            index_status="processing",
            index_started_at=(
                datetime.now(timezone.utc) - timedelta(minutes=31)
            ).isoformat(),
        )
        caller = FakeCallerClient(self.row, role="member")
        self.authenticate(caller)
        with (
            patch("main.supabase_admin", return_value=object()),
            patch(
                "main.index_authorized_resource",
                new=AsyncMock(return_value=self.successful_result()),
            ),
            TestClient(main.app) as api,
        ):
            response = api.post(f"/api/rag2/resources/{self.row['id']}/index")
        self.assertEqual(response.status_code, 200, response.text)


if __name__ == "__main__":
    unittest.main()
