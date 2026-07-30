import os
import time
import hashlib
import warnings
from contextlib import asynccontextmanager
# pyrefly: ignore [missing-import]
import httpx
# pyrefly: ignore [missing-import]
from fastapi import BackgroundTasks, FastAPI, HTTPException, Response
# pyrefly: ignore [missing-import]
from fastapi.middleware.cors import CORSMiddleware
# pyrefly: ignore [missing-import]
from dotenv import load_dotenv
from pathlib import Path
from typing import Literal

# Load env variables from Backend/.env using absolute path
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

import uuid
import json
import re
import io
import secrets
import string
from datetime import datetime, timedelta, timezone
from urllib.parse import quote
from fastapi import UploadFile, File, Header, Depends, Query
# pyrefly: ignore [missing-import]
from PIL import Image, UnidentifiedImageError
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator
from rag1 import initialize_rag1_persistence
from rag1.handoff import (
    Rag1HandoffError,
    handoff_rag2_resource_to_rag1,
)
from rag1.ingestion import RagIngestionError, ingest_rag_document
from rag1.service import (
    RagDocumentResolutionError,
    cache_rag_document,
    resolve_rag_document,
)
from rag1.conversation import (
    RAG_CHAT_HISTORY_LIMIT,
    RAG_CHAT_MESSAGE_MAX_CHARS,
    RAG_CHAT_QUESTION_MAX_CHARS,
    RAG_RETRIEVAL_K,
    RagChatProviderResponseError,
    build_contextualization_messages,
    build_grounded_answer_messages,
    conversation_cache_extra,
    generate_grounded_answer,
    usable_retrieval_query,
)
from rag1.sessions import (
    RagSessionError,
    create_study_session,
    list_study_sessions,
    open_study_session,
    session_response,
)
from rag2 import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    ChannelResourceCardMetadata,
    ChannelResourceMetadataRequest,
    Rag2AutomaticIngestionError,
    Rag2AutomaticIngestionResponse,
    Rag2ChannelResourceError,
    Rag2IndexingError,
    Rag2IndexingResponse,
    Rag2RatingError,
    Rag2RatingRequest,
    Rag2RatingSummary,
    Rag2ResourceAccessError,
    Rag2ResourceSearchError,
    Rag2ResourceSearchRequest,
    Rag2ResourceSearchResponse,
    Rag2SearchError,
    Rag2SearchRequest,
    Rag2SearchResponse,
    ServerResourceSummary,
    authorize_resource_for_access,
    delete_resource_rating,
    download_resource_for_access,
    has_safe_canonical_storage_path,
    get_channel_resource_metadata,
    index_authorized_resource,
    list_server_resources,
    register_attachment_for_rag2,
    resolve_authorized_resource,
    search_server_resources,
    search_server_chunks,
    set_resource_rating,
)
from lifecycle import (
    CHANNEL_FILES_BUCKET,
    LifecycleTargetError,
    parse_message_deletion_targets,
)
from pinning import PinResponse, PinnedMessageSummary, shape_pinned_messages

# OpenRouter LLM import
from langchain_openai import ChatOpenAI

# Map GEMINI_API_KEY to GOOGLE_API_KEY for langchain-google-genai compatibility
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if GEMINI_API_KEY and not os.getenv("GOOGLE_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = GEMINI_API_KEY

# Load OpenRouter configuration
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openrouter/auto")

# =====================================================================
# STARTUP LOGGING — safe, never prints secrets
# =====================================================================
print("=" * 60)
print("[BACKEND] StudyCord RAG Backend starting up...")
if os.getenv("GOOGLE_API_KEY"):
    print("[BACKEND] [OK] GEMINI_API_KEY/GOOGLE_API_KEY loaded (used for embeddings).")
else:
    print("[BACKEND] [!!] WARNING: GEMINI_API_KEY is not configured -- embeddings will fail.")

if OPENROUTER_API_KEY:
    masked = f"{OPENROUTER_API_KEY[:8]}...{OPENROUTER_API_KEY[-4:]}"
    print(f"[BACKEND] [OK] OPENROUTER_API_KEY loaded ({masked}).")
else:
    print("[BACKEND] [!!] WARNING: OPENROUTER_API_KEY is not configured -- generation will fail.")

print(f"[BACKEND] OpenRouter model: {OPENROUTER_MODEL}")
print("=" * 60)

METERED_DOMAIN = os.getenv("METERED_DOMAIN", "studycord.metered.live")
METERED_SECRET_KEY = os.getenv("METERED_SECRET_KEY")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

@asynccontextmanager
async def application_lifespan(application: FastAPI):
    """Initialize Phase 17.2 local metadata storage without changing RAG behavior."""
    persistence = initialize_rag1_persistence()
    application.state.rag1_data_dir = persistence.data_dir
    application.state.rag1_database_path = persistence.database_path
    yield


app = FastAPI(
    title="StudyCord Secure TURN API",
    lifespan=application_lifespan,
)

# Enable CORS for the frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =====================================================================
# OPENROUTER HELPER
# =====================================================================

def get_rag_chat_model(temperature: float = 0.3) -> ChatOpenAI:
    """
    Returns a ChatOpenAI instance routed through OpenRouter.
    Temperature can be tuned per-task (lower for structured, higher for chat).
    """
    if not OPENROUTER_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="OPENROUTER_API_KEY is not configured on the backend. Please add it to Backend/.env"
        )

    return ChatOpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=OPENROUTER_API_KEY,
        model=OPENROUTER_MODEL,
        temperature=temperature,
        request_timeout=120,
        default_headers={
            "HTTP-Referer": "http://localhost:5173",
            "X-Title": "StudyCord",
        },
    )


def _handle_openrouter_error(e: Exception, endpoint: str) -> HTTPException:
    """
    Translates OpenRouter / upstream errors into friendly frontend messages.
    Returns an HTTPException ready to be raised.
    """
    error_str = str(e).lower()
    detail_raw = str(e)

    # Try to extract status code from the error
    status_code = 500

    if "401" in error_str or "invalid api key" in error_str or "unauthorized" in error_str:
        status_code = 401
        detail = "OpenRouter API key is invalid or expired. Please check your OPENROUTER_API_KEY in Backend/.env."
    elif "402" in error_str or "insufficient" in error_str or "payment" in error_str or "credits" in error_str:
        status_code = 402
        detail = "OpenRouter account has insufficient credits. Please add credits or switch to a free model."
    elif "429" in error_str or "rate limit" in error_str or "too many requests" in error_str:
        status_code = 429
        detail = "Rate limit reached on the AI model. Please wait a moment and try again."
    elif "timeout" in error_str or "timed out" in error_str:
        status_code = 504
        detail = "The AI model took too long to respond. Please try again."
    elif "model" in error_str and ("not found" in error_str or "unavailable" in error_str or "not available" in error_str):
        status_code = 503
        detail = f"The selected AI model ({OPENROUTER_MODEL}) is currently unavailable. Please try again later or change the model in Backend/.env."
    elif "content" in error_str and ("filter" in error_str or "safety" in error_str or "moderation" in error_str):
        status_code = 422
        detail = "The AI model refused to generate a response for this content. Please try rephrasing your request."
    else:
        detail = f"AI generation failed. Please try again. (Error: {detail_raw[:200]})"

    print(f"[{endpoint}] OpenRouter error — status={status_code}, detail={detail}")
    return HTTPException(status_code=status_code, detail=detail)


# =====================================================================
# SERVER ADMINISTRATION HELPERS
# =====================================================================

PERMISSIONS = {
    "owner": {
        "view_server",
        "manage_server",
        "manage_channels",
        "manage_members",
        "manage_roles",
        "kick_members",
        "ban_members",
        "create_invites",
        "manage_invites",
        "transfer_ownership",
        "delete_server",
    },
    "admin": {
        "view_server",
        "manage_server",
        "manage_channels",
        "manage_members",
        "kick_members",
        "ban_members",
        "create_invites",
        "manage_invites",
    },
    "member": {"view_server"},
}

VALID_ROLES = {"owner", "admin", "member"}
ROLE_RANK = {"member": 1, "admin": 2, "owner": 3}
DEFAULT_CHANNELS = ("general", "assignments", "resources")
SERVER_ICONS_BUCKET = "server-icons"
SERVER_ICON_MAX_BYTES = 2 * 1024 * 1024
SERVER_ICON_FORMATS = {
    "JPEG": ("jpg", "image/jpeg"),
    "PNG": ("png", "image/png"),
    "WEBP": ("webp", "image/webp"),
}


class RoleUpdateRequest(BaseModel):
    role: str


class TransferOwnershipRequest(BaseModel):
    new_owner_id: str


class ReasonRequest(BaseModel):
    reason: str | None = None


class ServerUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None


class CreateServerRequest(BaseModel):
    name: str


class JoinServerRequest(BaseModel):
    invite_code: str


class CreateChannelRequest(BaseModel):
    name: str
    type: str = "text"


def _supabase_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_ANON_KEY)


class SupabaseRestClient:
    """Small PostgREST client with one fixed security context."""

    def __init__(self, name: str, api_key: str, bearer_token: str):
        self.name = name
        self.api_key = api_key
        self.bearer_token = bearer_token

    def _headers(self, prefer: str | None = None) -> dict[str, str]:
        headers = {
            "apikey": self.api_key,
            "Authorization": f"Bearer {self.bearer_token}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        return headers

    async def rest(self, method: str, path: str, *, params: dict | None = None, json_body=None, prefer: str | None = None):
        url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/{path}"
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.request(
                method,
                url,
                params=params,
                json=json_body,
                headers=self._headers(prefer),
            )
        if response.status_code >= 400:
            print(f"[SUPABASE:{self.name}] {method} {path} failed: {response.status_code} {response.text[:400]}")
            status_code = response.status_code if response.status_code in {400, 401, 403, 404, 409} else 500
            raise HTTPException(status_code=status_code, detail="Database operation was rejected.")
        return response.json() if response.text else None

    async def rpc(self, function_name: str, payload: dict):
        url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/rpc/{function_name}"
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(url, json=payload, headers=self._headers())
        if response.status_code >= 400:
            print(f"[SUPABASE-RPC:{self.name}] {function_name} failed: {response.status_code} {response.text[:400]}")
            if (
                "resource is already indexed" in response.text
                or "resource indexing is already in progress" in response.text
                or "indexing attempt is not active" in response.text
            ):
                raise HTTPException(
                    status_code=409,
                    detail="The resource indexing state changed. Refresh and try again.",
                )
            if "resource is not supported for RAG 2 indexing" in response.text:
                raise HTTPException(
                    status_code=422,
                    detail="This resource is not supported for RAG 2 indexing.",
                )
            if "current server membership required" in response.text:
                raise HTTPException(
                    status_code=403,
                    detail="Current server membership is required.",
                )
            if (
                "query embedding is invalid" in response.text
                or "search limit must be between 1 and 25" in response.text
                or "candidate limit must be between 1 and 100" in response.text
            ):
                raise HTTPException(
                    status_code=422,
                    detail="Semantic search parameters were rejected.",
                )
            if "rating resource not found" in response.text:
                raise HTTPException(
                    status_code=404,
                    detail="Resource not found.",
                )
            if (
                "rating requires a server-visible resource" in response.text
                or "current server membership required" in response.text
            ):
                raise HTTPException(
                    status_code=403,
                    detail="Resource rating is not available.",
                )
            if "rating must be between 1 and 5" in response.text:
                raise HTTPException(
                    status_code=422,
                    detail="Rating must be between 1 and 5.",
                )
            if "must be server owner" in response.text:
                raise HTTPException(status_code=403, detail="Only the server owner can transfer ownership.")
            if "new owner must be a current server member" in response.text:
                raise HTTPException(status_code=400, detail="New owner must be a current server member.")
            if "message not found" in response.text:
                raise HTTPException(status_code=404, detail="Message not found.")
            if "pin channel not found" in response.text:
                raise HTTPException(status_code=404, detail="Channel not found.")
            if (
                "pinning requires owner or admin" in response.text
                or "pin viewing requires current server membership" in response.text
            ):
                raise HTTPException(
                    status_code=403,
                    detail="You do not have permission to access channel pins.",
                )
            if "pin message and channel scope do not match" in response.text:
                raise HTTPException(
                    status_code=409,
                    detail="The message channel metadata is inconsistent.",
                )
            if (
                "only the message author may delete this message" in response.text
                or "server owner must transfer ownership or delete the server before leaving" in response.text
            ):
                raise HTTPException(status_code=403, detail=(
                    "Only the message author may delete this message."
                    if "message author" in response.text
                    else "Transfer ownership or delete the server before leaving."
                ))
            if (
                "message and channel scope do not match" in response.text
                or "message attachment scope does not match" in response.text
                or "message attachment cleanup target is invalid" in response.text
            ):
                raise HTTPException(
                    status_code=409,
                    detail="The message cleanup metadata is inconsistent.",
                )
            raise HTTPException(status_code=500, detail="Database function failed. Ensure the Phase 14 migration has been run.")
        return response.json() if response.text else None

    async def storage_list(self, bucket: str, prefix: str, *, limit: int, offset: int):
        url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/list/{bucket}"
        payload = {
            "prefix": prefix,
            "limit": limit,
            "offset": offset,
            "sortBy": {"column": "name", "order": "asc"},
        }
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(url, json=payload, headers=self._headers())
        if response.status_code >= 400:
            raise RuntimeError(
                f"Storage list failed with status {response.status_code}: {response.text[:400]}"
            )
        return response.json()

    async def storage_upload(self, bucket: str, path: str, content: bytes, content_type: str):
        url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/{bucket}/{path}"
        headers = {
            "apikey": self.api_key,
            "Authorization": f"Bearer {self.bearer_token}",
            "Content-Type": content_type,
            "Cache-Control": "max-age=31536000",
            "x-upsert": "false",
        }
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(url, content=content, headers=headers)
        if response.status_code >= 400:
            raise RuntimeError(f"Storage upload failed with status {response.status_code}.")
        return response.json() if response.text else None

    async def storage_remove(self, bucket: str, paths: list[str]):
        url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/{bucket}"
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.request(
                "DELETE",
                url,
                json={"prefixes": paths},
                headers=self._headers(),
            )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Storage delete failed with status {response.status_code}: {response.text[:400]}"
            )
        return response.json() if response.text else None

    async def storage_download(self, bucket: str, path: str, *, max_bytes: int):
        safe_bucket = quote(bucket, safe="")
        safe_path = quote(path, safe="/")
        url = (
            f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/authenticated/"
            f"{safe_bucket}/{safe_path}"
        )
        headers = {
            "apikey": self.api_key,
            "Authorization": f"Bearer {self.bearer_token}",
        }
        content = bytearray()
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("GET", url, headers=headers) as response:
                if response.status_code >= 400:
                    raise RuntimeError(
                        f"Storage download failed with status {response.status_code}."
                    )
                content_length = response.headers.get("content-length")
                if content_length:
                    try:
                        if int(content_length) > max_bytes:
                            raise RuntimeError("RAG2_DOWNLOAD_TOO_LARGE")
                    except ValueError:
                        pass
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > max_bytes:
                        raise RuntimeError("RAG2_DOWNLOAD_TOO_LARGE")
        return bytes(content)


def supabase_user(access_token: str) -> SupabaseRestClient:
    if not _supabase_configured():
        raise HTTPException(
            status_code=500,
            detail="Add SUPABASE_URL and SUPABASE_ANON_KEY to Backend/.env.",
        )
    return SupabaseRestClient("user", SUPABASE_ANON_KEY, access_token)


def supabase_admin() -> SupabaseRestClient:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise HTTPException(
            status_code=500,
            detail="This operation requires SUPABASE_SERVICE_ROLE_KEY in Backend/.env.",
        )
    return SupabaseRestClient("admin", SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SERVICE_ROLE_KEY)


async def cleanup_server_icon_objects(server_id: str):
    client = supabase_admin()
    prefix = f"{server_id}/"
    limit = 1000
    offset = 0
    paths: list[str] = []

    while True:
        objects = await client.storage_list(
            SERVER_ICONS_BUCKET,
            prefix,
            limit=limit,
            offset=offset,
        )
        for stored_object in objects:
            name = stored_object.get("name")
            if name:
                paths.append(name if name.startswith(prefix) else f"{prefix}{name}")
        if len(objects) < limit:
            break
        offset += limit

    for start in range(0, len(paths), 100):
        await client.storage_remove(SERVER_ICONS_BUCKET, paths[start:start + 100])


def validate_server_icon_content(content: bytes) -> tuple[str, str]:
    if not content:
        raise HTTPException(status_code=400, detail="The selected image is empty.")
    if len(content) > SERVER_ICON_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Server icons must be 2 MB or smaller.")

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as image:
                image_format = image.format
                image.verify()
            with Image.open(io.BytesIO(content)) as image:
                image.load()
                if not image.width or not image.height:
                    raise ValueError("Image has invalid dimensions.")
    except (
        UnidentifiedImageError,
        OSError,
        SyntaxError,
        ValueError,
        Image.DecompressionBombWarning,
        Image.DecompressionBombError,
    ):
        raise HTTPException(
            status_code=400,
            detail="The selected file is not a readable JPEG, PNG, or WebP image.",
        )

    icon_format = SERVER_ICON_FORMATS.get(image_format)
    if not icon_format:
        raise HTTPException(
            status_code=400,
            detail="Choose a JPEG, PNG, or WebP image. Other formats are not supported.",
        )
    return icon_format


async def get_current_user(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing authentication token.")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing authentication token.")

    if not _supabase_configured():
        raise HTTPException(status_code=500, detail="Supabase auth credentials are not configured on the backend.")

    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            f"{SUPABASE_URL.rstrip('/')}/auth/v1/user",
            headers={"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {token}"},
        )
    if response.status_code >= 400:
        raise HTTPException(status_code=401, detail="Invalid or expired authentication token.")
    user_data = response.json()
    user_id = user_data.get("id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid authentication token.")
    return {"id": user_id, "email": user_data.get("email"), "supabase_user": supabase_user(token)}


def _audit(action: str, server_id: str, actor_id: str, target_id: str | None = None, old_role: str | None = None, new_role: str | None = None, success: bool = True):
    print(json.dumps({
        "action": action,
        "server_id": server_id,
        "actor_user_id": actor_id,
        "target_user_id": target_id,
        "old_role": old_role,
        "new_role": new_role,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "success": success,
    }))


def generate_invite_code(length: int = 6) -> str:
    chars = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(length))


def normalize_channel_name(name: str) -> str:
    clean = re.sub(r"[^a-zA-Z0-9\s_-]", "", name.strip().lower())
    clean = re.sub(r"\s+", "-", clean)
    clean = re.sub(r"-+", "-", clean).strip("-_")
    if not clean:
        raise HTTPException(status_code=400, detail="Channel name is required.")
    return clean[:80]


async def get_server(client: SupabaseRestClient, server_id: str):
    rows = await client.rest("GET", "servers", params={"id": f"eq.{server_id}", "select": "*"})
    if not rows:
        raise HTTPException(status_code=404, detail="Server not found.")
    return rows[0]


async def get_server_member(client: SupabaseRestClient, server_id: str, user_id: str):
    rows = await client.rest(
        "GET",
        "server_members",
        params={"server_id": f"eq.{server_id}", "user_id": f"eq.{user_id}", "select": "*"},
    )
    return rows[0] if rows else None


async def get_server_member_role(client: SupabaseRestClient, server_id: str, user_id: str) -> str | None:
    member = await get_server_member(client, server_id, user_id)
    return member.get("role") if member else None


async def require_server_permission(client: SupabaseRestClient, server_id: str, user_id: str, permission: str) -> str:
    role = await get_server_member_role(client, server_id, user_id)
    if not role or permission not in PERMISSIONS.get(role, set()):
        raise HTTPException(status_code=403, detail="You do not have permission to perform this action.")
    return role


def can_manage_target_member(actor_role: str, target_role: str, action: str) -> bool:
    if target_role == "owner":
        return False
    if action in {"kick", "ban"}:
        return ROLE_RANK[actor_role] > ROLE_RANK[target_role]
    return actor_role == "owner"


def validate_role_change(actor_id: str, target_id: str, actor_role: str, target_role: str, new_role: str):
    if new_role not in {"admin", "member"}:
        raise HTTPException(status_code=400, detail="Role must be admin or member.")
    if actor_id == target_id:
        raise HTTPException(status_code=400, detail="You cannot change your own role.")
    if actor_role != "owner":
        raise HTTPException(status_code=403, detail="Only the server owner can change member roles.")
    if target_role == "owner":
        raise HTTPException(status_code=400, detail="The server owner role cannot be changed here.")
    if target_role == new_role:
        raise HTTPException(status_code=400, detail=f"Member is already {new_role}.")


async def cleanup_voice_presence(client: SupabaseRestClient, server_id: str, user_id: str):
    await client.rest(
        "DELETE",
        "voice_participants",
        params={"server_id": f"eq.{server_id}", "user_id": f"eq.{user_id}"},
    )


async def ensure_profile(client: SupabaseRestClient, user: dict):
    existing = await client.rest("GET", "profiles", params={"id": f"eq.{user['id']}", "select": "id"})
    if existing:
        return
    email = user.get("email") or ""
    username = email.split("@")[0] if email else f"user-{user['id'][:8]}"
    await client.rest(
        "POST",
        "profiles",
        json_body={"id": user["id"], "email": email, "username": username},
        prefer="return=minimal",
    )


@app.post("/api/servers")
async def create_server(request: CreateServerRequest, user=Depends(get_current_user)):
    client = user["supabase_user"]
    name = request.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Server name is required.")
    await ensure_profile(client, user)
    invite_code = generate_invite_code()
    server_id = str(uuid.uuid4())
    await client.rest(
        "POST",
        "servers",
        json_body={"id": server_id, "name": name[:80], "owner_id": user["id"], "invite_code": invite_code},
        prefer="return=minimal",
    )
    await client.rest(
        "POST",
        "server_members",
        json_body={"server_id": server_id, "user_id": user["id"], "role": "owner"},
        prefer="return=minimal",
    )
    channels = [{"server_id": server_id, "name": ch, "type": "text"} for ch in DEFAULT_CHANNELS]
    await client.rest("POST", "channels", json_body=channels, prefer="return=minimal")
    new_server = await get_server(client, server_id)
    _audit("create_server", server_id, user["id"], success=True)
    return {"success": True, "server": new_server}


@app.post("/api/servers/join")
async def join_server(request: JoinServerRequest, user=Depends(get_current_user)):
    client = user["supabase_user"]
    admin = supabase_admin()
    clean_code = request.invite_code.strip().upper()
    server_rows = await admin.rest("GET", "servers", params={"invite_code": f"eq.{clean_code}", "select": "*"})
    if not server_rows:
        raise HTTPException(status_code=404, detail="Invalid invite code. Server not found.")
    server = server_rows[0]

    bans = await admin.rest(
        "GET",
        "server_bans",
        params={"server_id": f"eq.{server['id']}", "user_id": f"eq.{user['id']}", "select": "id"},
    )
    if bans:
        raise HTTPException(status_code=403, detail="You are banned from this server.")

    existing = await get_server_member(client, server["id"], user["id"])
    if existing:
        return {"success": True, "server": server, "message": "You are already a member of this server!"}

    await ensure_profile(client, user)
    await client.rest(
        "POST",
        "server_members",
        json_body={"server_id": server["id"], "user_id": user["id"], "role": "member"},
        prefer="return=minimal",
    )
    _audit("join_server", server["id"], user["id"], success=True)
    return {"success": True, "server": server}


@app.post("/api/servers/{server_id}/channels")
async def create_channel(server_id: str, request: CreateChannelRequest, user=Depends(get_current_user)):
    client = user["supabase_user"]
    await require_server_permission(client, server_id, user["id"], "manage_channels")
    channel_type = request.type.strip().lower()
    if channel_type not in {"text", "voice"}:
        raise HTTPException(status_code=400, detail="Channel type must be text or voice.")
    channel = (await client.rest(
        "POST",
        "channels",
        json_body={"server_id": server_id, "name": normalize_channel_name(request.name), "type": channel_type},
        prefer="return=representation",
    ))[0]
    _audit("create_channel", server_id, user["id"], success=True)
    return {"success": True, "channel": channel}


@app.patch("/api/servers/{server_id}/members/{target_user_id}/role")
async def update_member_role(server_id: str, target_user_id: str, request: RoleUpdateRequest, user=Depends(get_current_user)):
    client = user["supabase_user"]
    actor_role = await require_server_permission(client, server_id, user["id"], "manage_roles")
    target = await get_server_member(client, server_id, target_user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target user is not a server member.")
    old_role = target["role"]
    validate_role_change(user["id"], target_user_id, actor_role, old_role, request.role)
    updated = (await client.rest(
        "PATCH",
        "server_members",
        params={"server_id": f"eq.{server_id}", "user_id": f"eq.{target_user_id}"},
        json_body={"role": request.role},
        prefer="return=representation",
    ))[0]
    _audit("update_member_role", server_id, user["id"], target_user_id, old_role, request.role, True)
    return {"success": True, "member": updated}


@app.post("/api/servers/{server_id}/transfer-ownership")
async def transfer_ownership(server_id: str, request: TransferOwnershipRequest, user=Depends(get_current_user)):
    client = user["supabase_user"]
    actor_role = await require_server_permission(client, server_id, user["id"], "transfer_ownership")
    if actor_role != "owner":
        raise HTTPException(status_code=403, detail="Only the server owner can transfer ownership.")
    if request.new_owner_id == user["id"]:
        raise HTTPException(status_code=400, detail="You already own this server.")
    target = await get_server_member(client, server_id, request.new_owner_id)
    if not target:
        raise HTTPException(status_code=400, detail="New owner must be a current server member.")
    await supabase_admin().rpc("transfer_server_ownership", {
        "p_server_id": server_id,
        "p_current_owner_id": user["id"],
        "p_new_owner_id": request.new_owner_id,
    })
    _audit("transfer_ownership", server_id, user["id"], request.new_owner_id, "owner", "owner", True)
    return {"success": True, "message": "Ownership transferred."}


@app.post("/api/servers/{server_id}/members/{target_user_id}/kick")
async def kick_member(server_id: str, target_user_id: str, request: ReasonRequest | None = None, user=Depends(get_current_user)):
    client = user["supabase_user"]
    actor_role = await require_server_permission(client, server_id, user["id"], "kick_members")
    if target_user_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot kick yourself.")
    target = await get_server_member(client, server_id, target_user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target user is not a server member.")
    if not can_manage_target_member(actor_role, target["role"], "kick"):
        raise HTTPException(status_code=403, detail="You cannot kick this member.")
    await cleanup_voice_presence(supabase_admin(), server_id, target_user_id)
    await client.rest(
        "DELETE",
        "server_members",
        params={"server_id": f"eq.{server_id}", "user_id": f"eq.{target_user_id}"},
    )
    _audit("kick_member", server_id, user["id"], target_user_id, target["role"], None, True)
    return {"success": True, "message": "Member kicked."}


@app.post("/api/servers/{server_id}/members/{target_user_id}/ban")
async def ban_member(server_id: str, target_user_id: str, request: ReasonRequest | None = None, user=Depends(get_current_user)):
    client = user["supabase_user"]
    actor_role = await require_server_permission(client, server_id, user["id"], "ban_members")
    if target_user_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot ban yourself.")
    target = await get_server_member(client, server_id, target_user_id)
    if target and not can_manage_target_member(actor_role, target["role"], "ban"):
        raise HTTPException(status_code=403, detail="You cannot ban this member.")
    server = await get_server(client, server_id)
    if target_user_id == server["owner_id"]:
        raise HTTPException(status_code=403, detail="The server owner cannot be banned.")

    existing_ban = await supabase_admin().rest(
        "GET",
        "server_bans",
        params={"server_id": f"eq.{server_id}", "user_id": f"eq.{target_user_id}", "select": "id"},
    )
    if existing_ban:
        raise HTTPException(status_code=409, detail="This user is already banned from the server.")

    await client.rest(
        "POST",
        "server_bans",
        json_body={
            "server_id": server_id,
            "user_id": target_user_id,
            "banned_by": user["id"],
            "reason": (request.reason if request else None),
        },
        prefer="return=minimal",
    )
    await cleanup_voice_presence(supabase_admin(), server_id, target_user_id)
    await client.rest(
        "DELETE",
        "server_members",
        params={"server_id": f"eq.{server_id}", "user_id": f"eq.{target_user_id}"},
    )
    _audit("ban_member", server_id, user["id"], target_user_id, target["role"] if target else None, None, True)
    return {"success": True, "message": "Member banned."}


@app.get("/api/servers/{server_id}/bans")
async def list_bans(server_id: str, user=Depends(get_current_user)):
    client = user["supabase_user"]
    actor_role = await require_server_permission(client, server_id, user["id"], "ban_members")
    if actor_role != "owner":
        raise HTTPException(status_code=403, detail="Only the server owner can view bans.")
    bans = await client.rest("GET", "server_bans", params={"server_id": f"eq.{server_id}", "select": "*", "order": "created_at.desc"})
    user_ids = sorted({b["user_id"] for b in bans} | {b["banned_by"] for b in bans})
    profiles = {}
    if user_ids:
        profile_rows = await client.rest("GET", "profiles", params={"id": f"in.({','.join(user_ids)})", "select": "id,username,full_name,avatar_url,email"})
        profiles = {p["id"]: p for p in profile_rows}
    return {
        "bans": [
            {
                **ban,
                "profile": profiles.get(ban["user_id"]),
                "banned_by_profile": profiles.get(ban["banned_by"]),
            }
            for ban in bans
        ]
    }


@app.delete("/api/servers/{server_id}/bans/{target_user_id}")
async def unban_member(server_id: str, target_user_id: str, user=Depends(get_current_user)):
    client = user["supabase_user"]
    actor_role = await require_server_permission(client, server_id, user["id"], "ban_members")
    if actor_role != "owner":
        raise HTTPException(status_code=403, detail="Only the server owner can unban users.")
    await client.rest("DELETE", "server_bans", params={"server_id": f"eq.{server_id}", "user_id": f"eq.{target_user_id}"})
    _audit("unban_member", server_id, user["id"], target_user_id, None, None, True)
    return {"success": True, "message": "User unbanned."}


@app.patch("/api/servers/{server_id}")
async def update_server(server_id: str, request: ServerUpdateRequest, user=Depends(get_current_user)):
    client = user["supabase_user"]
    await require_server_permission(client, server_id, user["id"], "manage_server")
    payload = {}
    if request.name is not None:
        name = request.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Server name is required.")
        payload["name"] = name[:80]
    if request.description is not None:
        payload["description"] = request.description.strip()[:500] if request.description else None
    if not payload:
        raise HTTPException(status_code=400, detail="No server settings were provided.")
    server = (await client.rest(
        "PATCH",
        "servers",
        params={"id": f"eq.{server_id}"},
        json_body=payload,
        prefer="return=representation",
    ))[0]
    _audit("update_server", server_id, user["id"], success=True)
    return {"success": True, "server": server}


@app.post("/api/servers/{server_id}/leave")
async def leave_server(server_id: uuid.UUID, user=Depends(get_current_user)):
    """Remove only the caller's non-owner membership and active voice presence."""
    canonical_server_id = str(server_id)
    client = user["supabase_user"]
    role = await require_server_permission(
        client,
        canonical_server_id,
        user["id"],
        "view_server",
    )
    server = await get_server(client, canonical_server_id)
    if role == "owner" or server.get("owner_id") == user["id"]:
        raise HTTPException(
            status_code=403,
            detail="Transfer ownership or delete the server before leaving.",
        )

    # Remove live media presence first. If cleanup fails, membership remains and
    # the caller can safely retry instead of leaving a stale participant row.
    try:
        await cleanup_voice_presence(
            supabase_admin(),
            canonical_server_id,
            user["id"],
        )
    except Exception as cleanup_error:
        print(
            "[LEAVE-SERVER] Voice presence cleanup failed "
            f"server_id={canonical_server_id} user_id={user['id']} "
            f"error={type(cleanup_error).__name__}"
        )
        raise HTTPException(
            status_code=502,
            detail="Could not leave the server safely. Please try again.",
        ) from cleanup_error

    await client.rpc("leave_server", {"p_server_id": canonical_server_id})
    _audit("leave_server", canonical_server_id, user["id"], success=True)
    return {"success": True, "server_id": canonical_server_id}


@app.delete("/api/messages/{message_id}")
async def delete_own_message(message_id: uuid.UUID, user=Depends(get_current_user)):
    """Delete an authored message after backend-only attachment cleanup."""
    client = user["supabase_user"]
    canonical_message_id = str(message_id)

    target_rows = await client.rpc(
        "prepare_own_message_deletion",
        {"p_message_id": canonical_message_id},
    )
    try:
        targets = parse_message_deletion_targets(
            target_rows,
            expected_user_id=user["id"],
        )
    except LifecycleTargetError as target_error:
        print(
            "[MESSAGE-DELETE] Rejected unsafe cleanup metadata "
            f"message_id={canonical_message_id}"
        )
        raise HTTPException(
            status_code=409,
            detail="The message attachment could not be cleaned up safely.",
        ) from target_error

    if targets:
        try:
            await supabase_admin().storage_remove(
                CHANNEL_FILES_BUCKET,
                [target.storage_path for target in targets],
            )
        except Exception as cleanup_error:
            print(
                "[MESSAGE-DELETE] Storage cleanup failed "
                f"message_id={canonical_message_id} "
                f"error={type(cleanup_error).__name__}"
            )
            # The database mutation has not run. The message stays visible and
            # the operation is safe to retry.
            raise HTTPException(
                status_code=502,
                detail="The attachment could not be removed. The message was not deleted.",
            ) from cleanup_error

    deleted = await client.rpc(
        "delete_own_message",
        {"p_message_id": canonical_message_id},
    )
    return {
        "success": True,
        "message_id": canonical_message_id,
        "deleted": bool(deleted),
    }


async def get_message_scope(
    client: SupabaseRestClient,
    message_id: str,
) -> dict:
    rows = await client.rest(
        "GET",
        "messages",
        params={
            "id": f"eq.{message_id}",
            "select": "id,server_id,channel_id",
            "limit": "1",
        },
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Message not found.")
    return rows[0]


async def get_channel_scope(
    client: SupabaseRestClient,
    channel_id: str,
) -> dict:
    rows = await client.rest(
        "GET",
        "channels",
        params={
            "id": f"eq.{channel_id}",
            "select": "id,server_id",
            "limit": "1",
        },
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Channel not found.")
    return rows[0]


@app.post(
    "/api/messages/{message_id}/pin",
    response_model=PinResponse,
)
async def pin_message(message_id: uuid.UUID, user=Depends(get_current_user)):
    client = user["supabase_user"]
    canonical_message_id = str(message_id)
    message = await get_message_scope(client, canonical_message_id)
    await require_server_permission(
        client,
        str(message["server_id"]),
        user["id"],
        "manage_server",
    )
    await client.rpc(
        "pin_channel_message",
        {"p_message_id": canonical_message_id},
    )
    return PinResponse(
        success=True,
        message_id=message_id,
        pinned=True,
    )


@app.delete(
    "/api/messages/{message_id}/pin",
    response_model=PinResponse,
)
async def unpin_message(message_id: uuid.UUID, user=Depends(get_current_user)):
    client = user["supabase_user"]
    canonical_message_id = str(message_id)
    message = await get_message_scope(client, canonical_message_id)
    await require_server_permission(
        client,
        str(message["server_id"]),
        user["id"],
        "manage_server",
    )
    await client.rpc(
        "unpin_channel_message",
        {"p_message_id": canonical_message_id},
    )
    return PinResponse(
        success=True,
        message_id=message_id,
        pinned=False,
    )


@app.get(
    "/api/channels/{channel_id}/pins",
    response_model=list[PinnedMessageSummary],
)
async def channel_pins(channel_id: uuid.UUID, user=Depends(get_current_user)):
    client = user["supabase_user"]
    canonical_channel_id = str(channel_id)
    channel = await get_channel_scope(client, canonical_channel_id)
    canonical_server_id = str(channel["server_id"])
    await require_server_permission(
        client,
        canonical_server_id,
        user["id"],
        "view_server",
    )
    rows = await client.rpc(
        "get_channel_pinned_messages",
        {"p_channel_id": canonical_channel_id},
    )
    try:
        return shape_pinned_messages(
            rows,
            expected_server_id=canonical_server_id,
            expected_channel_id=canonical_channel_id,
        )
    except (TypeError, ValueError) as result_error:
        print(
            "[MESSAGE-PINS] Rejected invalid database result "
            f"channel_id={canonical_channel_id}"
        )
        raise HTTPException(
            status_code=500,
            detail="Pinned messages could not be loaded.",
        ) from result_error


async def update_server_icon_path(
    client: SupabaseRestClient,
    server_id: str,
    icon_path: str | None,
):
    update_error = None
    try:
        rows = await client.rest(
            "PATCH",
            "servers",
            params={"id": f"eq.{server_id}"},
            json_body={"icon_path": icon_path},
            prefer="return=representation",
        )
        if rows:
            return rows[0]
    except HTTPException as error:
        update_error = error
        rows = None

    # A network response can be lost after Postgres commits. Confirm the
    # caller-RLS-protected row before deciding whether Storage needs rollback.
    confirmation = await get_server(client, server_id)
    if confirmation.get("icon_path") == icon_path:
        return confirmation
    if rows is not None:
        raise HTTPException(status_code=403, detail="The server icon update was not accepted.")
    raise update_error or HTTPException(
        status_code=500,
        detail="The server icon update could not be confirmed.",
    )


@app.put("/api/servers/{server_id}/icon")
async def upload_server_icon(
    server_id: str,
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    client = user["supabase_user"]
    await require_server_permission(client, server_id, user["id"], "manage_server")
    current_server = await get_server(client, server_id)

    try:
        content = await file.read(SERVER_ICON_MAX_BYTES + 1)
    finally:
        await file.close()
    extension, content_type = validate_server_icon_content(content)

    new_icon_path = f"{server_id}/{uuid.uuid4()}.{extension}"
    old_icon_path = current_server.get("icon_path")
    storage = supabase_admin()

    try:
        await storage.storage_upload(
            SERVER_ICONS_BUCKET,
            new_icon_path,
            content,
            content_type,
        )
    except Exception as upload_error:
        print(f"[SERVER-ICON-UPLOAD] Storage upload failed for server {server_id}: {upload_error}")
        raise HTTPException(status_code=502, detail="The server icon could not be uploaded.")

    try:
        server = await update_server_icon_path(client, server_id, new_icon_path)
    except Exception:
        try:
            await storage.storage_remove(SERVER_ICONS_BUCKET, [new_icon_path])
        except Exception as cleanup_error:
            print(f"[SERVER-ICON-CLEANUP] Upload rollback failed for server {server_id}: {cleanup_error}")
        raise

    if old_icon_path and old_icon_path != new_icon_path:
        try:
            await storage.storage_remove(SERVER_ICONS_BUCKET, [old_icon_path])
        except Exception as cleanup_error:
            print(f"[SERVER-ICON-CLEANUP] Old icon cleanup failed for server {server_id}: {cleanup_error}")

    _audit("update_server_icon", server_id, user["id"], success=True)
    return {"success": True, "server": server, "icon_path": server.get("icon_path")}


@app.delete("/api/servers/{server_id}/icon")
async def remove_server_icon(server_id: str, user=Depends(get_current_user)):
    client = user["supabase_user"]
    await require_server_permission(client, server_id, user["id"], "manage_server")
    current_server = await get_server(client, server_id)
    old_icon_path = current_server.get("icon_path")

    if not old_icon_path:
        return {"success": True, "server": current_server, "icon_path": None}

    server = await update_server_icon_path(client, server_id, None)
    try:
        await supabase_admin().storage_remove(SERVER_ICONS_BUCKET, [old_icon_path])
    except Exception as cleanup_error:
        print(f"[SERVER-ICON-CLEANUP] Removed icon cleanup failed for server {server_id}: {cleanup_error}")

    _audit("remove_server_icon", server_id, user["id"], success=True)
    return {"success": True, "server": server, "icon_path": None}


@app.post("/api/servers/{server_id}/regenerate-invite")
async def regenerate_invite(server_id: str, user=Depends(get_current_user)):
    client = user["supabase_user"]
    await require_server_permission(client, server_id, user["id"], "manage_invites")
    invite_code = generate_invite_code()
    server = (await supabase_admin().rest(
        "PATCH",
        "servers",
        params={"id": f"eq.{server_id}"},
        json_body={"invite_code": invite_code},
        prefer="return=representation",
    ))[0]
    _audit("regenerate_invite", server_id, user["id"], success=True)
    return {"success": True, "server": server}


@app.delete("/api/servers/{server_id}")
async def delete_server(server_id: str, user=Depends(get_current_user)):
    client = user["supabase_user"]
    actor_role = await require_server_permission(client, server_id, user["id"], "delete_server")
    if actor_role != "owner":
        raise HTTPException(status_code=403, detail="Only the server owner can delete this server.")
    await client.rest("DELETE", "servers", params={"id": f"eq.{server_id}"})
    try:
        await cleanup_server_icon_objects(server_id)
    except Exception as cleanup_error:
        print(f"[SERVER-ICON-CLEANUP] Failed for server {server_id}: {cleanup_error}")
    _audit("delete_server", server_id, user["id"], success=True)
    return {"success": True, "message": "Server deleted."}


# =====================================================================
# RAG 2 RESOURCE FOUNDATION
# =====================================================================

@app.get(
    "/api/rag2/servers/{server_id}/resources",
    response_model=list[ServerResourceSummary],
)
async def rag2_server_resources(
    server_id: uuid.UUID,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user=Depends(get_current_user),
):
    client = user["supabase_user"]
    canonical_server_id = str(server_id)
    await require_server_permission(
        client,
        canonical_server_id,
        user["id"],
        "view_server",
    )
    return await list_server_resources(
        client,
        canonical_server_id,
        limit=limit,
        offset=offset,
    )


@app.post(
    "/api/rag2/servers/{server_id}/resources/channel-metadata",
    response_model=list[ChannelResourceCardMetadata],
)
async def rag2_channel_resource_metadata(
    server_id: uuid.UUID,
    request: ChannelResourceMetadataRequest,
    user=Depends(get_current_user),
):
    caller_client = user["supabase_user"]
    canonical_server_id = str(server_id)
    await require_server_permission(
        caller_client,
        canonical_server_id,
        user["id"],
        "view_server",
    )
    try:
        return await get_channel_resource_metadata(
            caller_client,
            canonical_server_id,
            [str(resource_id) for resource_id in request.resource_ids],
        )
    except Rag2ChannelResourceError as error:
        raise HTTPException(error.status_code, error.detail) from error


async def _prepare_rag2_indexing(
    caller_client,
    resource,
    user_id: str,
    *,
    accept_existing: bool,
) -> bool:
    """Apply the manual indexing authorization and lifecycle rules once."""
    role = await get_server_member_role(
        caller_client,
        resource.server_id,
        user_id,
    )
    if not role:
        raise HTTPException(
            status_code=403,
            detail="Current server membership is required.",
        )
    if (
        resource.uploader_id != user_id
        and "manage_server" not in PERMISSIONS.get(role, set())
    ):
        raise HTTPException(
            status_code=403,
            detail="Only the uploader or a server manager may index this resource.",
        )
    if (
        resource.visibility != "server"
        or resource.storage_bucket != "channel-files"
        or not has_safe_canonical_storage_path(resource.storage_path)
    ):
        raise HTTPException(
            status_code=422,
            detail="This resource is not supported for RAG 2 indexing.",
        )
    if resource.index_status == "ready":
        if accept_existing:
            return False
        raise HTTPException(status_code=409, detail="The resource is already indexed.")
    if resource.index_status == "processing":
        try:
            started_at = datetime.fromisoformat(
                str(resource.index_started_at).replace("Z", "+00:00")
            )
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=409,
                detail="The resource has an invalid active indexing state.",
            )
        if started_at >= datetime.now(timezone.utc) - timedelta(minutes=30):
            if accept_existing:
                return False
            raise HTTPException(
                status_code=409,
                detail="Resource indexing is already in progress.",
            )
    elif resource.index_status not in {"unindexed", "failed"}:
        raise HTTPException(
            status_code=409,
            detail="The resource indexing state is not currently supported.",
        )
    return True


async def _run_automatic_rag2_indexing(resource) -> None:
    """Isolate semantic enrichment failure from the committed attachment."""
    try:
        await index_authorized_resource(resource, supabase_admin())
    except Rag2IndexingError as error:
        print(
            "[RAG2-AUTO] indexing did not complete "
            f"resource_id={resource.id} status={error.status_code}"
        )
    except Exception as error:
        print(
            "[RAG2-AUTO] indexing did not complete "
            f"resource_id={resource.id} error={type(error).__name__}"
        )


@app.post(
    "/api/rag2/attachments/{attachment_id}/ingest",
    response_model=Rag2AutomaticIngestionResponse,
    status_code=202,
)
async def rag2_automatically_ingest_attachment(
    attachment_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    user=Depends(get_current_user),
):
    caller_client = user["supabase_user"]
    try:
        resource_id = await register_attachment_for_rag2(
            caller_client,
            str(attachment_id),
        )
        resource = await resolve_authorized_resource(
            caller_client,
            resource_id,
        )
    except Rag2AutomaticIngestionError as error:
        raise HTTPException(error.status_code, error.detail) from error
    except Rag2IndexingError as error:
        raise HTTPException(error.status_code, error.detail) from error

    should_schedule = await _prepare_rag2_indexing(
        caller_client,
        resource,
        user["id"],
        accept_existing=True,
    )
    if should_schedule:
        background_tasks.add_task(
            _run_automatic_rag2_indexing,
            resource,
        )
    return Rag2AutomaticIngestionResponse(
        resource_id=resource_id,
        indexing_scheduled=should_schedule,
    )


@app.get("/api/rag2/resources/{resource_id}/access")
async def rag2_access_resource(
    resource_id: uuid.UUID,
    user=Depends(get_current_user),
):
    caller_client = user["supabase_user"]
    try:
        resource = await authorize_resource_for_access(
            caller_client,
            str(resource_id),
            user["id"],
            require_server_permission,
        )
    except Rag2ResourceAccessError as error:
        raise HTTPException(error.status_code, error.detail) from error

    # Privileged Storage access is constructed only after caller-scoped
    # resolution, current membership, scope, and canonical path validation.
    try:
        trusted_client = supabase_admin()
        payload = await download_resource_for_access(
            resource,
            trusted_client,
        )
    except Rag2ResourceAccessError as error:
        raise HTTPException(error.status_code, error.detail) from error
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail="Unable to open this resource.",
        ) from error
    disposition = "inline" if payload.inline else "attachment"
    return Response(
        content=payload.content,
        media_type=payload.media_type,
        headers={
            "Content-Disposition": (
                f'{disposition}; filename="{payload.filename}"'
            ),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.post(
    "/api/rag2/resources/{resource_id}/index",
    response_model=Rag2IndexingResponse,
)
async def rag2_index_resource(
    resource_id: uuid.UUID,
    user=Depends(get_current_user),
):
    caller_client = user["supabase_user"]
    try:
        resource = await resolve_authorized_resource(
            caller_client,
            str(resource_id),
        )
    except Rag2IndexingError as error:
        raise HTTPException(error.status_code, error.detail) from error

    await _prepare_rag2_indexing(
        caller_client,
        resource,
        user["id"],
        accept_existing=False,
    )

    # Trusted access is deliberately constructed only after caller-scoped
    # resolution, current membership, authority, scope, and state checks.
    trusted_client = supabase_admin()
    try:
        result = await index_authorized_resource(resource, trusted_client)
    except Rag2IndexingError as error:
        raise HTTPException(error.status_code, error.detail) from error
    return Rag2IndexingResponse(
        resource_id=result.resource_id,
        server_id=result.server_id,
        detected_type=result.detected_type,
        chunk_count=result.chunk_count,
        embedding_model=EMBEDDING_MODEL,
        embedding_dimensions=EMBEDDING_DIMENSIONS,
        indexed_at=result.indexed_at,
    )


@app.post(
    "/api/rag2/servers/{server_id}/search",
    response_model=Rag2SearchResponse,
)
async def rag2_search_server(
    server_id: uuid.UUID,
    request: Rag2SearchRequest,
    user=Depends(get_current_user),
):
    caller_client = user["supabase_user"]
    canonical_server_id = str(server_id)

    # Membership authorization deliberately precedes provider usage.
    await require_server_permission(
        caller_client,
        canonical_server_id,
        user["id"],
        "view_server",
    )
    try:
        results = await search_server_chunks(
            caller_client,
            canonical_server_id,
            request.query,
            limit=request.limit,
        )
    except Rag2SearchError as error:
        raise HTTPException(error.status_code, error.detail) from error
    return Rag2SearchResponse(
        server_id=server_id,
        query=request.query,
        results=results,
    )


@app.post(
    "/api/rag2/servers/{server_id}/resources/search",
    response_model=Rag2ResourceSearchResponse,
)
async def rag2_search_server_resources(
    server_id: uuid.UUID,
    request: Rag2ResourceSearchRequest,
    user=Depends(get_current_user),
):
    caller_client = user["supabase_user"]
    canonical_server_id = str(server_id)

    # Membership authorization deliberately precedes provider usage.
    await require_server_permission(
        caller_client,
        canonical_server_id,
        user["id"],
        "view_server",
    )
    try:
        results = await search_server_resources(
            caller_client,
            canonical_server_id,
            request.query,
            limit=request.limit,
        )
    except Rag2ResourceSearchError as error:
        raise HTTPException(error.status_code, error.detail) from error
    return Rag2ResourceSearchResponse(
        server_id=server_id,
        query=request.query,
        results=results,
    )


@app.put(
    "/api/rag2/resources/{resource_id}/rating",
    response_model=Rag2RatingSummary,
)
async def rag2_set_resource_rating(
    resource_id: uuid.UUID,
    request: Rag2RatingRequest,
    user=Depends(get_current_user),
):
    try:
        return await set_resource_rating(
            user["supabase_user"],
            str(resource_id),
            request.rating,
        )
    except Rag2RatingError as error:
        raise HTTPException(error.status_code, error.detail) from error


@app.delete(
    "/api/rag2/resources/{resource_id}/rating",
    response_model=Rag2RatingSummary,
)
async def rag2_delete_resource_rating(
    resource_id: uuid.UUID,
    user=Depends(get_current_user),
):
    try:
        return await delete_resource_rating(
            user["supabase_user"],
            str(resource_id),
        )
    except Rag2RatingError as error:
        raise HTTPException(error.status_code, error.detail) from error


# =====================================================================
# CACHING
# =====================================================================

# In-memory generated-result cache, isolated by authenticated user and document.
_generation_cache: dict[str, dict] = {}


def _cache_key(
    user_id: str,
    doc_id: str,
    cache_type: str,
    extra: str = "",
) -> str:
    """Generate a deterministic cache key."""
    raw = f"{user_id}:{doc_id}:{cache_type}:{extra}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _get_cached(
    user_id: str,
    doc_id: str,
    cache_type: str,
    extra: str = "",
):
    key = _cache_key(user_id, doc_id, cache_type, extra)
    return _generation_cache.get(key)


def _set_cached(
    user_id: str,
    doc_id: str,
    cache_type: str,
    value,
    extra: str = "",
):
    key = _cache_key(user_id, doc_id, cache_type, extra)
    _generation_cache[key] = value


# =====================================================================
# TURN CREDENTIALS (unchanged)
# =====================================================================

@app.get("/api/turn-credentials")
async def get_turn_credentials():
    if not METERED_SECRET_KEY:
        print("[TURN-API] METERED_SECRET_KEY environment variable is not set.")
        raise HTTPException(
            status_code=500,
            detail="METERED_SECRET_KEY environment variable is not set on the backend."
        )

    post_url = f"https://{METERED_DOMAIN}/api/v1/turn/credential"
    post_params = {"secretKey": METERED_SECRET_KEY}
    post_data = {"label": "studycord-dev", "expiryInSeconds": 3600}

    masked_secret = f"{METERED_SECRET_KEY[:4]}...{METERED_SECRET_KEY[-4:]}" if METERED_SECRET_KEY and len(METERED_SECRET_KEY) > 8 else "***"
    print(f"[TURN-API] Creating TURN credential. URL: {post_url}?secretKey={masked_secret}, Body: {post_data}")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            # Step 1: Create TURN credential
            post_response = await client.post(post_url, params=post_params, json=post_data)
            post_response.raise_for_status()
            credential_info = post_response.json()
            
            api_key = credential_info.get("apiKey")
            if not api_key:
                print(f"[TURN-API] POST response did not contain 'apiKey'. Response: {credential_info}")
                raise HTTPException(
                    status_code=502,
                    detail="Failed to retrieve apiKey from Metered credential creation."
                )

            # Step 2: Fetch ICE servers using the api key
            get_url = f"https://{METERED_DOMAIN}/api/v1/turn/credentials"
            get_params = {"apiKey": api_key}
            
            masked_api_key = f"{api_key[:4]}...{api_key[-4:]}" if len(api_key) > 8 else "***"
            print(f"[TURN-API] Fetching ICE servers. URL: {get_url}?apiKey={masked_api_key}")

            get_response = await client.get(get_url, params=get_params)
            get_response.raise_for_status()
            
            ice_servers = get_response.json()
            return ice_servers
    except httpx.HTTPStatusError as e:
        print(f"[TURN-API] Metered API returned error status {e.response.status_code}: {e.response.text}")
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch credentials from Metered API: {e.response.text}"
        )
    except Exception as e:
        print(f"[TURN-API] Connection error fetching Metered credentials: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal connection error: {str(e)}"
        )

# =====================================================================
# STUDYCORD BASIC RAG MVP ENDPOINTS
# =====================================================================

def parse_json_from_response(content: str):
    # Try direct parse
    try:
        return json.loads(content.strip())
    except json.JSONDecodeError:
        pass
        
    # Try to find json block using regex
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", content)
    if match:
        try:
            return json.loads(match.group(1).strip())
        except json.JSONDecodeError:
            pass
            
    # Try finding the first '[' or '{' and last ']' or '}'
    start_idx = min(content.find('{') if '{' in content else len(content), content.find('[') if '[' in content else len(content))
    end_idx = max(content.rfind('}') if '}' in content else -1, content.rfind(']') if ']' in content else -1)
    if start_idx < end_idx:
        try:
            return json.loads(content[start_idx:end_idx+1])
        except json.JSONDecodeError:
            pass
            
    raise ValueError("Response could not be parsed as valid JSON.")

class ChatHistoryMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: str
    content: str = Field(
        min_length=1,
        max_length=RAG_CHAT_MESSAGE_MAX_CHARS,
    )

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        if value not in {"user", "assistant"}:
            raise ValueError("History role must be user or assistant.")
        return value

    @field_validator("content")
    @classmethod
    def trim_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("History content must not be blank.")
        return value.strip()


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(
        min_length=1,
        max_length=RAG_CHAT_QUESTION_MAX_CHARS,
    )
    mode: str = "chat"
    doc_id: str = Field(
        validation_alias=AliasChoices("document_id", "doc_id"),
    )
    history: list[ChatHistoryMessage] = Field(
        default_factory=list,
        max_length=RAG_CHAT_HISTORY_LIMIT,
    )

    @field_validator("question")
    @classmethod
    def trim_question(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Question must not be blank.")
        return value.strip()

class DocRequest(BaseModel):
    doc_id: str


class Rag1HandoffResponse(BaseModel):
    status: str = "success"
    doc_id: uuid.UUID
    session_id: uuid.UUID
    filename: str
    detected_type: Literal["pdf", "docx", "txt"]
    reused: bool


def _resolve_request_document(user_id: str, document_id: str):
    try:
        return resolve_rag_document(user_id, document_id)
    except RagDocumentResolutionError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail=error.detail,
        ) from error


@app.post("/api/rag/upload")
async def rag_upload(
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    if not os.getenv("GOOGLE_API_KEY"):
        raise HTTPException(
            status_code=400,
            detail="GEMINI_API_KEY is not configured on the backend. Please add it to Backend/.env"
        )

    try:
        result = await ingest_rag_document(file, user["id"])
        session = create_study_session(
            user["id"],
            result.doc_id,
            result.filename,
        )
        cache_rag_document(
            user["id"],
            result.doc_id,
            result.vector_store,
            result.text,
            result.filename,
        )
        return {
            "status": "success",
            "doc_id": result.doc_id,
            "session_id": session.id,
            "filename": result.filename,
            "num_chunks": result.chunk_count,
        }
    except RagIngestionError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail)
    except Exception as error:
        print(f"[RAG-UPLOAD] Unexpected error: {type(error).__name__}")
        raise HTTPException(status_code=500, detail="Failed to process document.")


@app.post(
    "/api/rag1/imports/rag2/{resource_id}",
    response_model=Rag1HandoffResponse,
)
async def rag1_import_rag2_resource(
    resource_id: uuid.UUID,
    response: Response,
    user=Depends(get_current_user),
):
    try:
        result = await handoff_rag2_resource_to_rag1(
            caller_client=user["supabase_user"],
            user_id=user["id"],
            resource_id=str(resource_id),
            require_permission=require_server_permission,
            trusted_client_factory=supabase_admin,
        )
    except Rag1HandoffError as error:
        raise HTTPException(error.status_code, error.detail) from error
    response.status_code = 200 if result.reused else 201
    return Rag1HandoffResponse(
        doc_id=result.doc_id,
        session_id=result.session_id,
        filename=result.filename,
        detected_type=result.detected_type,
        reused=result.reused,
    )


@app.get("/api/rag/sessions")
async def rag_session_history(user=Depends(get_current_user)):
    try:
        sessions = list_study_sessions(user["id"])
        return [session_response(session) for session in sessions]
    except Exception as error:
        print(f"[RAG-SESSIONS] List failed: {type(error).__name__}")
        raise HTTPException(
            status_code=500,
            detail="Study history could not be loaded.",
        ) from error


@app.get("/api/rag/sessions/{session_id}")
async def rag_open_session(
    session_id: str,
    user=Depends(get_current_user),
):
    try:
        session = open_study_session(user["id"], session_id)
        return session_response(session)
    except RagSessionError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail=error.detail,
        ) from error
    except Exception as error:
        print(f"[RAG-SESSIONS] Open failed: {type(error).__name__}")
        raise HTTPException(
            status_code=500,
            detail="Study session could not be opened.",
        ) from error


@app.post("/api/rag/chat")
async def rag_chat(
    request: ChatRequest,
    user=Depends(get_current_user),
):
    endpoint = "RAG-CHAT"
    print(f"[{endpoint}] Request received — model={OPENROUTER_MODEL}")
    start_time = time.time()

    doc_data = _resolve_request_document(user["id"], request.doc_id)
    cache_extra = conversation_cache_extra(
        request.history,
        request.question,
    )

    # Check cache for repeated chat questions
    cached = _get_cached(
        doc_data.metadata.user_id,
        doc_data.metadata.id,
        "chat",
        cache_extra,
    )
    if cached is not None:
        elapsed = time.time() - start_time
        print(f"[{endpoint}] Completed in {elapsed:.2f}s — CACHE HIT")
        return cached

    try:
        retrieval_query = request.question
        contextualization_used = False
        contextualization_fallback = False
        if request.history:
            try:
                contextualizer = get_rag_chat_model(temperature=0)
                rewrite_response = await contextualizer.ainvoke(
                    build_contextualization_messages(
                        request.history,
                        request.question,
                    )
                )
                rewritten_query = usable_retrieval_query(
                    rewrite_response.content
                )
                if rewritten_query is None:
                    contextualization_fallback = True
                else:
                    retrieval_query = rewritten_query
                    contextualization_used = True
            except Exception as rewrite_error:
                contextualization_fallback = True
                print(
                    f"[{endpoint}] Contextualization fallback - "
                    f"error={type(rewrite_error).__name__}"
                )

        print(
            f"[{endpoint}] Context - "
            f"history_message_count={len(request.history)}, "
            f"contextualization_used={contextualization_used}, "
            f"fallback={contextualization_fallback}"
        )

        db = doc_data.vector_store
        docs = db.similarity_search(retrieval_query, k=RAG_RETRIEVAL_K)
        context = "\n\n".join([doc.page_content for doc in docs])
        
        chat = get_rag_chat_model(temperature=0.3)
        prompt = build_grounded_answer_messages(
            context,
            request.history,
            request.question,
        )
        
        try:
            answer = await generate_grounded_answer(chat, prompt)
        except RagChatProviderResponseError as provider_response_error:
            response_kind = (
                "blocked"
                if provider_response_error.blocked
                else "malformed"
            )
            print(
                f"[{endpoint}] Provider response rejected - "
                f"kind={response_kind}"
            )
            raise HTTPException(
                status_code=(
                    422 if provider_response_error.blocked else 502
                ),
                detail="Unable to generate an answer for this request.",
            ) from provider_response_error
        result = {"answer": answer}

        # Cache the result
        _set_cached(
            doc_data.metadata.user_id,
            doc_data.metadata.id,
            "chat",
            result,
            cache_extra,
        )

        elapsed = time.time() - start_time
        print(f"[{endpoint}] Completed in {elapsed:.2f}s — GENERATED (model={OPENROUTER_MODEL})")
        return result
    except HTTPException:
        raise
    except Exception as e:
        print(f"[{endpoint}] Error: {str(e)}")
        raise _handle_openrouter_error(e, endpoint)


@app.post("/api/rag/summary")
async def rag_summary(
    request: DocRequest,
    user=Depends(get_current_user),
):
    endpoint = "RAG-SUMMARY"
    start_time = time.time()

    doc_data = _resolve_request_document(user["id"], request.doc_id)
    print(
        f"[{endpoint}] Request received — model={OPENROUTER_MODEL}, "
        f"doc_id={doc_data.metadata.id[:12]}..."
    )

    # Check cache
    cached = _get_cached(
        doc_data.metadata.user_id,
        doc_data.metadata.id,
        "summary",
    )
    if cached is not None:
        elapsed = time.time() - start_time
        print(f"[{endpoint}] Completed in {elapsed:.2f}s — CACHE HIT")
        return cached

    try:
        text = doc_data.text[:50000]  # truncate to stay within safe prompt length
        chat = get_rag_chat_model(temperature=0.2)
        
        prompt = (
            "Analyze the provided document text and generate a structured summary. "
            "You MUST reply ONLY with a valid JSON object matching the following structure:\n"
            "{\n"
            "  \"executive_summary\": \"A concise 2-3 paragraph summary of the entire document.\",\n"
            "  \"key_concepts\": [\n"
            "    {\"concept\": \"Name of concept\", \"description\": \"Definition/explanation of the concept\"}\n"
            "  ],\n"
            "  \"key_points\": [\n"
            "    \"Important point or takeaway 1\",\n"
            "    \"Important point or takeaway 2\"\n"
            "  ]\n"
            "}\n\n"
            "Do not include any formatting, markdown wrappers, or explanation outside of the raw JSON object.\n\n"
            f"Document Text:\n{text}"
        )
        
        response = await chat.ainvoke(prompt)
        parsed_json = parse_json_from_response(response.content)

        # Cache the result
        _set_cached(
            doc_data.metadata.user_id,
            doc_data.metadata.id,
            "summary",
            parsed_json,
        )

        elapsed = time.time() - start_time
        print(f"[{endpoint}] Completed in {elapsed:.2f}s — GENERATED (model={OPENROUTER_MODEL})")
        return parsed_json
    except HTTPException:
        raise
    except ValueError as e:
        print(f"[{endpoint}] JSON parsing error: {str(e)}")
        raise HTTPException(status_code=500, detail="The AI model returned a response that could not be parsed. Please try again.")
    except Exception as e:
        print(f"[{endpoint}] Error: {str(e)}")
        raise _handle_openrouter_error(e, endpoint)


@app.post("/api/rag/flashcards")
async def rag_flashcards(
    request: DocRequest,
    user=Depends(get_current_user),
):
    endpoint = "RAG-FLASHCARDS"
    start_time = time.time()

    doc_data = _resolve_request_document(user["id"], request.doc_id)
    print(
        f"[{endpoint}] Request received — model={OPENROUTER_MODEL}, "
        f"doc_id={doc_data.metadata.id[:12]}..."
    )

    # Check cache
    cached = _get_cached(
        doc_data.metadata.user_id,
        doc_data.metadata.id,
        "flashcards",
    )
    if cached is not None:
        elapsed = time.time() - start_time
        print(f"[{endpoint}] Completed in {elapsed:.2f}s — CACHE HIT")
        return cached

    try:
        text = doc_data.text[:50000]
        chat = get_rag_chat_model(temperature=0.3)
        
        prompt = (
            "Analyze the provided document text and generate a list of 5 to 8 high-quality revision flashcards. "
            "You MUST reply ONLY with a valid JSON array matching the following structure:\n"
            "[\n"
            "  {\"question\": \"A clear, specific study question?\", \"answer\": \"A concise, informative answer explaining the concept.\"}\n"
            "]\n\n"
            "Do not include any formatting, markdown wrappers, or explanation outside of the raw JSON array.\n\n"
            f"Document Text:\n{text}"
        )
        
        response = await chat.ainvoke(prompt)
        parsed_json = parse_json_from_response(response.content)
        result = {"flashcards": parsed_json}

        # Cache the result
        _set_cached(
            doc_data.metadata.user_id,
            doc_data.metadata.id,
            "flashcards",
            result,
        )

        elapsed = time.time() - start_time
        print(f"[{endpoint}] Completed in {elapsed:.2f}s — GENERATED (model={OPENROUTER_MODEL})")
        return result
    except HTTPException:
        raise
    except ValueError as e:
        print(f"[{endpoint}] JSON parsing error: {str(e)}")
        raise HTTPException(status_code=500, detail="The AI model returned a response that could not be parsed. Please try again.")
    except Exception as e:
        print(f"[{endpoint}] Error: {str(e)}")
        raise _handle_openrouter_error(e, endpoint)


@app.post("/api/rag/mcq")
async def rag_mcq(
    request: DocRequest,
    user=Depends(get_current_user),
):
    endpoint = "RAG-MCQ"
    start_time = time.time()

    doc_data = _resolve_request_document(user["id"], request.doc_id)
    print(
        f"[{endpoint}] Request received — model={OPENROUTER_MODEL}, "
        f"doc_id={doc_data.metadata.id[:12]}..."
    )

    # Check cache
    cached = _get_cached(
        doc_data.metadata.user_id,
        doc_data.metadata.id,
        "mcq",
    )
    if cached is not None:
        elapsed = time.time() - start_time
        print(f"[{endpoint}] Completed in {elapsed:.2f}s — CACHE HIT")
        return cached

    try:
        text = doc_data.text[:50000]
        chat = get_rag_chat_model(temperature=0.3)
        
        prompt = (
            "Analyze the provided document text and generate 5 multiple-choice questions (MCQs) for revision. "
            "Each question must have exactly 4 unique options, and one correct answer (which must exactly match one of the options). "
            "You MUST reply ONLY with a valid JSON array matching the following structure:\n"
            "[\n"
            "  {\n"
            "    \"question\": \"Question text here?\",\n"
            "    \"options\": [\"Option 1\", \"Option 2\", \"Option 3\", \"Option 4\"],\n"
            "    \"correct_answer\": \"Option 2\"\n"
            "  }\n"
            "]\n\n"
            "Do not include any formatting, markdown wrappers, or explanation outside of the raw JSON array.\n\n"
            f"Document Text:\n{text}"
        )
        
        response = await chat.ainvoke(prompt)
        parsed_json = parse_json_from_response(response.content)
        result = {"mcqs": parsed_json}

        # Cache the result
        _set_cached(
            doc_data.metadata.user_id,
            doc_data.metadata.id,
            "mcq",
            result,
        )

        elapsed = time.time() - start_time
        print(f"[{endpoint}] Completed in {elapsed:.2f}s — GENERATED (model={OPENROUTER_MODEL})")
        return result
    except HTTPException:
        raise
    except ValueError as e:
        print(f"[{endpoint}] JSON parsing error: {str(e)}")
        raise HTTPException(status_code=500, detail="The AI model returned a response that could not be parsed. Please try again.")
    except Exception as e:
        print(f"[{endpoint}] Error: {str(e)}")
        raise _handle_openrouter_error(e, endpoint)

if __name__ == "__main__":
    # pyrefly: ignore [missing-import]
    import uvicorn
    # Read port from env if needed, default to 8000
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
