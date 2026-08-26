"""Provider-neutral contracts and failure classification for LLM generation."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

import httpx
from openai import APIConnectionError, APITimeoutError


FALLBACK_HTTP_STATUS_CODES = frozenset({429, 500, 502, 503, 504})


class LLMProviderError(Exception):
    """Base class for expected provider-layer failures."""


class ProviderConfigurationError(LLMProviderError):
    """The selected provider is not configured correctly."""

    def __init__(self, provider: str, detail: str):
        super().__init__(detail)
        self.provider = provider
        self.detail = detail


class ProviderGenerationError(LLMProviderError):
    """A provider request failed before yielding a usable response."""

    def __init__(
        self,
        *,
        provider: str,
        category: str,
        retryable_with_fallback: bool,
        status_code: int | None = None,
    ):
        self.provider = provider
        self.category = category
        self.retryable_with_fallback = retryable_with_fallback
        self.status_code = status_code
        reason = str(status_code) if status_code is not None else category
        super().__init__(f"{provider} generation failed ({reason})")

    @property
    def safe_reason(self) -> str:
        return str(self.status_code) if self.status_code is not None else self.category


def _status_code_from_exception(error: Exception) -> int | None:
    status_code = getattr(error, "status_code", None)
    if isinstance(status_code, int):
        return status_code
    response = getattr(error, "response", None)
    response_status = getattr(response, "status_code", None)
    return response_status if isinstance(response_status, int) else None


def classify_provider_error(
    provider: str,
    error: Exception,
) -> ProviderGenerationError:
    """Classify only explicitly transient failures as eligible for fallback."""
    status_code = _status_code_from_exception(error)
    error_text = str(error).lower()
    if "quota exceeded" in error_text or "insufficient_quota" in error_text:
        return ProviderGenerationError(
            provider=provider,
            category="quota_exceeded",
            status_code=status_code,
            retryable_with_fallback=True,
        )

    if status_code is not None:
        return ProviderGenerationError(
            provider=provider,
            category="http_error",
            status_code=status_code,
            retryable_with_fallback=status_code in FALLBACK_HTTP_STATUS_CODES,
        )

    if isinstance(error, (TimeoutError, httpx.TimeoutException, APITimeoutError)):
        return ProviderGenerationError(
            provider=provider,
            category="timeout",
            retryable_with_fallback=True,
        )

    if isinstance(error, (ConnectionError, httpx.NetworkError, APIConnectionError)):
        return ProviderGenerationError(
            provider=provider,
            category="connection_error",
            retryable_with_fallback=True,
        )

    return ProviderGenerationError(
        provider=provider,
        category="provider_error",
        retryable_with_fallback=False,
    )


class LLMProvider(ABC):
    """Interface implemented by each generation provider."""

    name: str
    model: str

    @abstractmethod
    async def generate(self, prompt: Any, *, temperature: float) -> Any:
        """Generate a provider response for a prompt or message sequence."""
