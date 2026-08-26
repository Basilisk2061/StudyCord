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

    async def generate(
        self,
        prompt: Any,
        *,
        temperature: float = 0.3,
    ) -> Any:
        primary = self._providers[self.primary_provider]
        primary_display_name = PROVIDER_DISPLAY_NAMES[primary.name]
        print(f"LLM Provider: {primary_display_name}")
        started = perf_counter()
        try:
            response = await primary.generate(prompt, temperature=temperature)
        except ProviderGenerationError as error:
            elapsed = perf_counter() - started
            print(f"Generation Time: {elapsed:.2f}s")
            if (
                not error.retryable_with_fallback
                or self.fallback_provider == self.primary_provider
            ):
                raise

            fallback = self._providers[self.fallback_provider]
            fallback_display_name = PROVIDER_DISPLAY_NAMES[fallback.name]
            print(
                f"{primary_display_name} failed ({error.safe_reason})"
            )
            print(f"Switching to {fallback_display_name}...")
            print(f"LLM Provider: {fallback_display_name}")
            fallback_started = perf_counter()
            try:
                response = await fallback.generate(
                    prompt,
                    temperature=temperature,
                )
            finally:
                fallback_elapsed = perf_counter() - fallback_started
                print(f"Generation Time: {fallback_elapsed:.2f}s")
            return response
        else:
            elapsed = perf_counter() - started
            print(f"Generation Time: {elapsed:.2f}s")
            return response
