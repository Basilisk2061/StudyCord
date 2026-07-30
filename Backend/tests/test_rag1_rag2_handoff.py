import asyncio
import sys
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
from rag1.db import (
    RagDocumentRepository,
    RagResourceImportRepository,
    RagSessionRepository,
)
from rag1.handoff import Rag1HandoffError, handoff_rag2_resource_to_rag1
from rag1.service import clear_rag_document_cache


def resource_row(resource_id, server_id, **overrides):
    row = {
        "id": resource_id,
        "server_id": server_id,
        "original_filename": "study.txt",
        "storage_bucket": "channel-files",
        "storage_path": f"{server_id}/channel/user/study.txt",
        "visibility": "server",
        "index_status": "ready",
        "detected_type": "txt",
        "size_bytes": 18,
    }
    row.update(overrides)
    return row


class FakeCallerClient:
    def __init__(self, row):
        self.row = row
        self.calls = []

    async def rest(self, method, path, *, params=None, **_kwargs):
        self.calls.append((method, path, params))
        return [self.row] if self.row else []


class FakeTrustedClient:
    def __init__(self, content=b"trusted study text"):
        self.content = content
        self.calls = []

    async def storage_download(self, bucket, path, *, max_bytes):
        self.calls.append((bucket, path, max_bytes))
        return self.content


class FailingTrustedClient:
    async def storage_download(self, *_args, **_kwargs):
        raise RuntimeError("storage unavailable")


class FakeVectorStore:
    def save_local(self, directory):
        target = Path(directory)
        (target / "index.faiss").write_bytes(b"faiss")
        (target / "index.pkl").write_bytes(b"docstore")


async def allow_member(client, server_id, user_id, permission):
    client.calls.append(("permission", server_id, user_id, permission))
    return "member"


class Rag1Rag2HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temporary.name)
        self.documents = RagDocumentRepository(self.data_dir)
        self.sessions = RagSessionRepository(self.data_dir)
        self.imports = RagResourceImportRepository(self.data_dir)
        self.user_id = str(uuid.uuid4())
        self.other_user_id = str(uuid.uuid4())
        self.server_id = str(uuid.uuid4())
        self.resource_id = str(uuid.uuid4())
        self.row = resource_row(self.resource_id, self.server_id)

    def tearDown(self):
        main.app.dependency_overrides.clear()
        clear_rag_document_cache()
        self.temporary.cleanup()

    def handoff(self, user_id=None, caller=None, trusted_factory=None):
        caller = caller or FakeCallerClient(self.row)
        trusted = FakeTrustedClient()
        factory = trusted_factory or Mock(return_value=trusted)
        with (
            patch("rag1.ingestion._build_embeddings", return_value=object()),
            patch(
                "rag1.ingestion._build_vector_store",
                return_value=FakeVectorStore(),
            ),
        ):
            result = asyncio.run(
                handoff_rag2_resource_to_rag1(
                    caller_client=caller,
                    user_id=user_id or self.user_id,
                    resource_id=self.resource_id,
                    require_permission=allow_member,
                    trusted_client_factory=factory,
                    imports=self.imports,
                    documents=self.documents,
                    sessions=self.sessions,
                )
            )
        return result, caller, factory, trusted

    def test_authorized_handoff_creates_owned_document_session_and_safe_result(self):
        result, caller, factory, trusted = self.handoff()
        self.assertFalse(result.reused)
        document = self.documents.get_for_user(result.doc_id, self.user_id)
        session = self.sessions.get_for_user(result.session_id, self.user_id)
        self.assertIsNotNone(document)
        self.assertIsNotNone(session)
        self.assertEqual(session.document_id, document.id)
        self.assertEqual(caller.calls[0][1], "server_resources")
        self.assertEqual(caller.calls[1][0], "permission")
        factory.assert_called_once_with()
        self.assertEqual(len(trusted.calls), 1)
        self.assertNotIn("storage", result.__dict__)

    def test_completed_retry_reauthorizes_and_reuses_without_storage_or_embedding(self):
        first, _, _, _ = self.handoff()
        second_factory = Mock(side_effect=AssertionError("service role used"))
        caller = FakeCallerClient(self.row)
        with patch("rag1.ingestion._build_vector_store") as vector_builder:
            second = asyncio.run(
                handoff_rag2_resource_to_rag1(
                    caller_client=caller,
                    user_id=self.user_id,
                    resource_id=self.resource_id,
                    require_permission=allow_member,
                    trusted_client_factory=second_factory,
                    imports=self.imports,
                    documents=self.documents,
                    sessions=self.sessions,
                )
            )
        self.assertTrue(second.reused)
        self.assertEqual(second.doc_id, first.doc_id)
        self.assertEqual(second.session_id, first.session_id)
        vector_builder.assert_not_called()
        second_factory.assert_not_called()
        self.assertEqual(caller.calls[1][0], "permission")

    def test_authorization_and_validation_precede_mapping_and_service_role(self):
        factory = Mock(side_effect=AssertionError("service role used"))
        with self.assertRaises(Rag1HandoffError) as missing:
            asyncio.run(
                handoff_rag2_resource_to_rag1(
                    caller_client=FakeCallerClient(None),
                    user_id=self.user_id,
                    resource_id=self.resource_id,
                    require_permission=allow_member,
                    trusted_client_factory=factory,
                    imports=self.imports,
                    documents=self.documents,
                    sessions=self.sessions,
                )
            )
        self.assertEqual(missing.exception.status_code, 404)
        factory.assert_not_called()

        for override in (
            {"visibility": "private"},
            {"index_status": "processing"},
            {"detected_type": None},
            {"storage_bucket": "other"},
            {"storage_path": "../unsafe.txt"},
        ):
            with self.subTest(override=override):
                with self.assertRaises(Rag1HandoffError):
                    asyncio.run(
                        handoff_rag2_resource_to_rag1(
                            caller_client=FakeCallerClient(
                                resource_row(
                                    self.resource_id,
                                    self.server_id,
                                    **override,
                                )
                            ),
                            user_id=self.user_id,
                            resource_id=self.resource_id,
                            require_permission=allow_member,
                            trusted_client_factory=factory,
                            imports=self.imports,
                            documents=self.documents,
                            sessions=self.sessions,
                        )
                    )
        factory.assert_not_called()

    def test_nonmember_is_denied_before_mapping_and_service_role(self):
        async def deny_member(*_args):
            raise HTTPException(403, "denied")

        factory = Mock(side_effect=AssertionError("service role used"))
        with self.assertRaises(HTTPException) as denied:
            asyncio.run(
                handoff_rag2_resource_to_rag1(
                    caller_client=FakeCallerClient(self.row),
                    user_id=self.user_id,
                    resource_id=self.resource_id,
                    require_permission=deny_member,
                    trusted_client_factory=factory,
                    imports=self.imports,
                    documents=self.documents,
                    sessions=self.sessions,
                )
            )
        self.assertEqual(denied.exception.status_code, 403)
        factory.assert_not_called()

    def test_storage_failure_is_safe_and_retryable(self):
        factory = Mock(return_value=FailingTrustedClient())
        with self.assertRaises(Rag1HandoffError) as raised:
            asyncio.run(
                handoff_rag2_resource_to_rag1(
                    caller_client=FakeCallerClient(self.row),
                    user_id=self.user_id,
                    resource_id=self.resource_id,
                    require_permission=allow_member,
                    trusted_client_factory=factory,
                    imports=self.imports,
                    documents=self.documents,
                    sessions=self.sessions,
                )
            )
        self.assertEqual(raised.exception.status_code, 503)
        self.assertNotIn("storage unavailable", raised.exception.detail)
        retry = self.imports.claim(
            self.user_id,
            self.resource_id,
            self.server_id,
            uuid.uuid4(),
            datetime.now(timezone.utc).isoformat(),
            (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat(),
        )
        self.assertEqual(retry.action, "ingest")

    def test_corrupt_content_marks_attempt_failed_without_artifacts(self):
        factory = Mock(return_value=FakeTrustedClient(b"\x00not plain text"))
        with self.assertRaises(Rag1HandoffError) as raised:
            asyncio.run(
                handoff_rag2_resource_to_rag1(
                    caller_client=FakeCallerClient(self.row),
                    user_id=self.user_id,
                    resource_id=self.resource_id,
                    require_permission=allow_member,
                    trusted_client_factory=factory,
                    imports=self.imports,
                    documents=self.documents,
                    sessions=self.sessions,
                )
            )
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(self.documents.list_for_user(self.user_id), [])
        retry = self.imports.claim(
            self.user_id,
            self.resource_id,
            self.server_id,
            uuid.uuid4(),
            datetime.now(timezone.utc).isoformat(),
            (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat(),
        )
        self.assertEqual(retry.action, "ingest")

    def test_concurrent_claim_allows_exactly_one_ingestion_attempt(self):
        now = datetime.now(timezone.utc)

        def claim_once(_index):
            return self.imports.claim(
                self.user_id,
                self.resource_id,
                self.server_id,
                uuid.uuid4(),
                now.isoformat(),
                (now - timedelta(minutes=30)).isoformat(),
            ).action

        with ThreadPoolExecutor(max_workers=8) as workers:
            actions = list(workers.map(claim_once, range(8)))
        self.assertEqual(actions.count("ingest"), 1)
        self.assertEqual(actions.count("processing"), 7)

    def test_session_failure_is_document_ready_and_retry_does_not_reembed(self):
        trusted = FakeTrustedClient()
        factory = Mock(return_value=trusted)
        with (
            patch("rag1.ingestion._build_embeddings", return_value=object()),
            patch(
                "rag1.ingestion._build_vector_store",
                return_value=FakeVectorStore(),
            ) as vector_builder,
            patch(
                "rag1.handoff.create_study_session",
                side_effect=RuntimeError("session unavailable"),
            ),
        ):
            with self.assertRaises(Rag1HandoffError):
                asyncio.run(
                    handoff_rag2_resource_to_rag1(
                        caller_client=FakeCallerClient(self.row),
                        user_id=self.user_id,
                        resource_id=self.resource_id,
                        require_permission=allow_member,
                        trusted_client_factory=factory,
                        imports=self.imports,
                        documents=self.documents,
                        sessions=self.sessions,
                    )
                )
        vector_builder.assert_called_once()

        record = self.imports.claim(
            self.user_id,
            self.resource_id,
            self.server_id,
            uuid.uuid4(),
            datetime.now(timezone.utc).isoformat(),
            (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat(),
        )
        self.assertEqual(record.action, "recover_document")
        # Return the claim to document_ready to simulate a clean retry entry.
        self.imports.mark_document_ready(
            self.user_id,
            self.resource_id,
            record.record.attempt_id,
            datetime.now(timezone.utc).isoformat(),
        )

        no_storage = Mock(side_effect=AssertionError("storage used"))
        with patch("rag1.ingestion._build_vector_store") as rebuilt:
            recovered = asyncio.run(
                handoff_rag2_resource_to_rag1(
                    caller_client=FakeCallerClient(self.row),
                    user_id=self.user_id,
                    resource_id=self.resource_id,
                    require_permission=allow_member,
                    trusted_client_factory=no_storage,
                    imports=self.imports,
                    documents=self.documents,
                    sessions=self.sessions,
                )
            )
        self.assertFalse(recovered.reused)
        rebuilt.assert_not_called()
        no_storage.assert_not_called()

    def test_stale_attempt_cannot_overwrite_newer_claim(self):
        old = datetime.now(timezone.utc) - timedelta(hours=2)
        first_attempt = str(uuid.uuid4())
        first = self.imports.claim(
            self.user_id,
            self.resource_id,
            self.server_id,
            first_attempt,
            old.isoformat(),
            (old - timedelta(minutes=30)).isoformat(),
        )
        self.assertEqual(first.action, "ingest")

        second_attempt = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        second = self.imports.claim(
            self.user_id,
            self.resource_id,
            self.server_id,
            second_attempt,
            now.isoformat(),
            (now - timedelta(minutes=30)).isoformat(),
        )
        self.assertEqual(second.action, "ingest")
        self.assertFalse(
            self.imports.mark_failed(
                self.user_id,
                self.resource_id,
                first_attempt,
                now.isoformat(),
            )
        )
        self.assertTrue(
            self.imports.mark_failed(
                self.user_id,
                self.resource_id,
                second_attempt,
                now.isoformat(),
            )
        )

    def test_same_resource_isolated_for_two_users(self):
        first, _, _, _ = self.handoff(self.user_id)
        second, _, _, _ = self.handoff(self.other_user_id)
        self.assertNotEqual(first.doc_id, second.doc_id)
        self.assertNotEqual(first.session_id, second.session_id)
        self.assertIsNone(
            self.documents.get_for_user(first.doc_id, self.other_user_id)
        )

    def test_endpoint_auth_uuid_status_and_safe_response(self):
        with TestClient(main.app) as api:
            self.assertEqual(
                api.post(
                    f"/api/rag1/imports/rag2/{self.resource_id}"
                ).status_code,
                401,
            )

        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": self.user_id,
            "email": None,
            "supabase_user": object(),
        }
        result = type(
            "Result",
            (),
            {
                "doc_id": str(uuid.uuid4()),
                "session_id": str(uuid.uuid4()),
                "filename": "study.txt",
                "detected_type": "txt",
                "reused": False,
            },
        )()
        with (
            patch(
                "main.handoff_rag2_resource_to_rag1",
                new=AsyncMock(return_value=result),
            ),
            patch("main.supabase_admin") as admin,
            TestClient(main.app) as api,
        ):
            response = api.post(
                f"/api/rag1/imports/rag2/{self.resource_id}"
            )
            invalid = api.post("/api/rag1/imports/rag2/not-a-uuid")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(
            set(response.json()),
            {
                "status",
                "doc_id",
                "session_id",
                "filename",
                "detected_type",
                "reused",
            },
        )
        self.assertNotIn("storage", response.text.lower())
        admin.assert_not_called()


if __name__ == "__main__":
    unittest.main()
