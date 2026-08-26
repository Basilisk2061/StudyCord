"""Provider selection, observability, and bounded automatic fallback."""

from __future__ import annotations

import os
from time import perf_counter
from typing import Any, Mapping

from .base import (
    LLMProvider,
    ProviderConfigurationError,
    ProviderGenerationError,
)
from .nvidia_provider import NvidiaProvider
from .openrouter_provider import OpenRouterProvider


SUPPORTED_PROVIDERS = frozenset({"nvidia", "openrouter"})
PROVIDER_DISPLAY_NAMES = {
    "nvidia": "NVIDIA",
    "openrouter": "OpenRouter",
}
LOG_SEPARATOR = "-" * 36


def _provider_name(value: str | None, *, default: str) -> str:
    name = (value or default).strip().lower()
    if name not in SUPPORTED_PROVIDERS:
        raise ProviderConfigurationError(
            name or "unknown",
            f"Unsupported LLM provider: {name or '<empty>'}.",
        )
    return name


class ProviderManager:
    """Generate through a primary provider with one eligible fallback attempt."""

    def __init__(
        self,
        *,
        providers: Mapping[str, LLMProvider],
        primary_provider: str,
        fallback_provider: str,
    ):
        self._providers = dict(providers)
        self.primary_provider = _provider_name(primary_provider, default="nvidia")
        self.fallback_provider = _provider_name(
            fallback_provider,
            default="openrouter",
        )
        for provider_name in {self.primary_provider, self.fallback_provider}:
            if provider_name not in self._providers:
                raise ProviderConfigurationError(
                    provider_name,
                    f"LLM provider is not registered: {provider_name}.",
                )

    @classmethod
    def from_environment(cls) -> "ProviderManager":
        providers: dict[str, LLMProvider] = {
            "nvidia": NvidiaProvider(
                api_key=os.getenv("NVIDIA_API_KEY"),
                model=os.getenv("NVIDIA_MODEL"),
            ),
            "openrouter": OpenRouterProvider(
                api_key=os.getenv("OPENROUTER_API_KEY"),
                model=os.getenv("OPENROUTER_MODEL", "openrouter/auto"),
            ),
        }
        return cls(
            providers=providers,
            primary_provider=os.getenv("PRIMARY_LLM_PROVIDER", "nvidia"),
            fallback_provider=os.getenv(
                "FALLBACK_LLM_PROVIDER",
                "openrouter",
            ),
        )

    def model_for(self, provider_name: str) -> str:
        return self._providers[provider_name].model

    def display_name_for(self, provider_name: str) -> str:
        return PROVIDER_DISPLAY_NAMES[provider_name]

    @staticmethod
    def _log_provider(provider: LLMProvider) -> None:
        print(LOG_SEPARATOR)
        print(f"LLM Provider: {PROVIDER_DISPLAY_NAMES[provider.name]}")
        print(f"Model: {provider.model or '<not configured>'}")
        print(LOG_SEPARATOR)

    async def generate(
        self,
        prompt: Any,
        *,
        temperature: float = 0.3,
    ) -> Any:
        primary = self._providers[self.primary_provider]
        primary_display_name = PROVIDER_DISPLAY_NAMES[primary.name]
        self._log_provider(primary)
        started = perf_counter()
        try:
            response = await primary.generate(prompt, temperature=temperature)
        except ProviderGenerationError as error:
            elapsed_ms = (perf_counter() - started) * 1_000
            print(f"Generation Time: {elapsed_ms:.2f} ms")
            if (
                not error.retryable_with_fallback
                or self.fallback_provider == self.primary_provider
            ):
                raise

            fallback = self._providers[self.fallback_provider]
            fallback_display_name = PROVIDER_DISPLAY_NAMES[fallback.name]
            print(LOG_SEPARATOR)
            print(f"{primary_display_name} generation failed.")
            print(f"Reason: {error}")
            print(f"Switching to {fallback_display_name}...")
            self._log_provider(fallback)
            fallback_started = perf_counter()
            try:
                response = await fallback.generate(
                    prompt,
                    temperature=temperature,
                )
            finally:
                fallback_elapsed_ms = (perf_counter() - fallback_started) * 1_000
                print(f"Generation Time: {fallback_elapsed_ms:.2f} ms")
            return response
        else:
            elapsed_ms = (perf_counter() - started) * 1_000
            print(f"Generation Time: {elapsed_ms:.2f} ms")
            return response
