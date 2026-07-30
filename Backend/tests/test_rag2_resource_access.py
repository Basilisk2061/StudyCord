import asyncio
import inspect
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import main
from rag2.access import (
    RESOURCE_ACCESS_MAX_BYTES,
    Rag2ResourceAccessError,
    ResourceAccessPayload,
    download_resource_for_access,
    resolve_resource_for_access,
    safe_download_filename,
    validate_resource_for_access,
)


def make_resource(**overrides):
    row = {
        "id": str(uuid.uuid4()),
        "server_id": str(uuid.uuid4()),
        "original_filename": "study notes.pdf",
        "storage_bucket": "channel-files",
        "storage_path": "server/channel/user/document.pdf",
        "visibility": "server",
        "index_status": "ready",
        "detected_type": "pdf",
        "size_bytes": 128,
    }
    row.update(overrides)
    return row


class FakeCallerClient:
    def __init__(self, row=None, role="member"):
        self.row = row
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
            return [self.row] if self.row else []
        if path == "server_members":
            return [{"role": self.role}] if self.role else []
        raise AssertionError(path)


class FakeTrustedClient:
    def __init__(self, content=b"%PDF-1.7 original", error=None):
        self.content = content
        self.error = error
        self.calls = []

    async def storage_download(self, bucket, path, *, max_bytes):
        self.calls.append((bucket, path, max_bytes))
        if self.error:
            raise self.error
        return self.content


class Rag2ResourceAccessServiceTests(unittest.TestCase):
    def test_caller_resolution_uses_resource_id_and_canonical_fields_only(self):
        row = make_resource()
        caller = FakeCallerClient(row)
        resource = asyncio.run(
            resolve_resource_for_access(caller, row["id"])
        )
        self.assertEqual(resource.server_id, row["server_id"])
        method, path, params = caller.calls[0]
        self.assertEqual((method, path), ("GET", "server_resources"))
        self.assertEqual(params["id"], f"eq.{row['id']}")
        self.assertNotIn("url", params["select"])

    def test_missing_private_nonready_unsupported_and_unsafe_are_inaccessible(self):
        caller = FakeCallerClient(None)
        with self.assertRaises(Rag2ResourceAccessError) as missing:
            asyncio.run(resolve_resource_for_access(caller, str(uuid.uuid4())))
        self.assertEqual(missing.exception.status_code, 404)

        cases = (
            {"visibility": "private"},
            {"index_status": "unindexed"},
            {"detected_type": None},
            {"detected_type": "pptx"},
            {"storage_bucket": "other"},
            {"storage_path": "server/../secret.pdf"},
            {"size_bytes": None},
            {"size_bytes": RESOURCE_ACCESS_MAX_BYTES + 1},
        )
        for override in cases:
            with self.subTest(override=override):
                resource = asyncio.run(
                    resolve_resource_for_access(
                        FakeCallerClient(make_resource(**override)),
                        str(uuid.uuid4()),
                    )
                )
                with self.assertRaises(Rag2ResourceAccessError) as denied:
                    validate_resource_for_access(resource)
                self.assertEqual(denied.exception.status_code, 404)

    def test_download_uses_only_canonical_storage_and_preserves_original_bytes(self):
        row = make_resource()
        resource = asyncio.run(
            resolve_resource_for_access(FakeCallerClient(row), row["id"])
        )
        trusted = FakeTrustedClient()
        payload = asyncio.run(
            download_resource_for_access(resource, trusted)
        )
        self.assertEqual(payload.content, trusted.content)
        self.assertEqual(
            trusted.calls,
            [(
                row["storage_bucket"],
                row["storage_path"],
                RESOURCE_ACCESS_MAX_BYTES,
            )],
        )
        self.assertTrue(payload.inline)
        self.assertEqual(payload.media_type, "application/pdf")

    def test_storage_failures_and_header_filenames_are_safe(self):
        row = make_resource()
        resource = asyncio.run(
            resolve_resource_for_access(FakeCallerClient(row), row["id"])
        )
        with self.assertRaises(Rag2ResourceAccessError) as failed:
            asyncio.run(
                download_resource_for_access(
                    resource,
                    FakeTrustedClient(error=RuntimeError("storage secret")),
                )
            )
        self.assertEqual(failed.exception.status_code, 500)
        self.assertEqual(failed.exception.detail, "Unable to open this resource.")
        self.assertEqual(
            safe_download_filename('../bad"name;.pdf', "pdf"),
            "_badname.pdf",
        )


class Rag2ResourceAccessEndpointTests(unittest.TestCase):
    def setUp(self):
        self.user_id = str(uuid.uuid4())
        self.row = make_resource()

    def tearDown(self):
        main.app.dependency_overrides.clear()

    def authenticate(self, caller):
        main.app.dependency_overrides[main.get_current_user] = lambda: {
            "id": self.user_id,
            "email": None,
            "supabase_user": caller,
        }

    def test_authentication_uuid_and_current_membership_are_required(self):
        with TestClient(main.app) as api:
            self.assertEqual(
                api.get(f"/api/rag2/resources/{self.row['id']}/access").status_code,
                401,
            )

        self.authenticate(FakeCallerClient(self.row))
        with TestClient(main.app) as api:
            self.assertEqual(
                api.get("/api/rag2/resources/not-a-uuid/access").status_code,
                422,
            )

        caller = FakeCallerClient(self.row, role=None)
        self.authenticate(caller)
        with patch("main.supabase_admin") as admin, TestClient(main.app) as api:
            denied = api.get(
                f"/api/rag2/resources/{self.row['id']}/access"
            )
        self.assertEqual(denied.status_code, 403)
        admin.assert_not_called()
        self.assertEqual(
            [call[1] for call in caller.calls],
            ["server_resources", "server_members"],
        )

    def test_private_cross_scope_and_missing_are_denied_before_storage(self):
        cases = (
            (None, "member", 404),
            (make_resource(visibility="private"), "member", 404),
            (make_resource(storage_path="../other.pdf"), "member", 404),
            (make_resource(), None, 403),
        )
        for row, role, expected in cases:
            with self.subTest(expected=expected, role=role):
                caller = FakeCallerClient(row, role=role)
                self.authenticate(caller)
                resource_id = row["id"] if row else str(uuid.uuid4())
                with (
                    patch("main.supabase_admin") as admin,
                    TestClient(main.app) as api,
                ):
                    response = api.get(
                        f"/api/rag2/resources/{resource_id}/access"
                    )
                self.assertEqual(response.status_code, expected)
                admin.assert_not_called()

    def test_authorized_access_returns_binary_without_storage_metadata(self):
        caller = FakeCallerClient(self.row, role="member")
        self.authenticate(caller)
        payload = ResourceAccessPayload(
            content=b"%PDF original bytes",
            media_type="application/pdf",
            filename="study notes.pdf",
            inline=True,
        )
        trusted = object()
        with (
            patch("main.supabase_admin", return_value=trusted) as admin,
            patch(
                "main.download_resource_for_access",
                new=AsyncMock(return_value=payload),
            ) as download,
            TestClient(main.app) as api,
        ):
            response = api.get(
                f"/api/rag2/resources/{self.row['id']}/access"
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, payload.content)
        self.assertEqual(response.headers["content-type"], "application/pdf")
        self.assertIn("inline", response.headers["content-disposition"])
        self.assertEqual(response.headers["cache-control"], "private, no-store")
        admin.assert_called_once()
        download.assert_awaited_once()
        self.assertNotIn("channel-files", response.text)
        self.assertNotIn(self.row["storage_path"], response.text)

    def test_trusted_storage_configuration_failure_is_safe(self):
        caller = FakeCallerClient(self.row, role="member")
        self.authenticate(caller)
        with (
            patch(
                "main.supabase_admin",
                side_effect=RuntimeError("service credential detail"),
            ),
            TestClient(main.app) as api,
        ):
            response = api.get(
                f"/api/rag2/resources/{self.row['id']}/access"
            )
        self.assertEqual(response.status_code, 500)
        self.assertEqual(
            response.json()["detail"],
            "Unable to open this resource.",
        )

    def test_access_does_not_register_index_or_change_ranking(self):
        source = inspect.getsource(main.rag2_access_resource)
        for forbidden in (
            "register_server_resource",
            "index_authorized_resource",
            "embedding",
            "resource_chunks",
            "set_resource_rating",
        ):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
