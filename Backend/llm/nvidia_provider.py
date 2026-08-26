"""NVIDIA NIM generation provider."""

from __future__ import annotations

from typing import Any

from langchain_openai import ChatOpenAI

from .base import (
    LLMProvider,
    ProviderConfigurationError,
    classify_provider_error,
)


NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1"


class NvidiaProvider(LLMProvider):
    name = "nvidia"

    def __init__(self, *, api_key: str | None, model: str | None):
        self.api_key = api_key
        self.model = (model or "").strip()

    async def generate(self, prompt: Any, *, temperature: float) -> Any:
        if not self.api_key:
            raise ProviderConfigurationError(
                self.name,
                "NVIDIA_API_KEY is not configured.",
            )
        if not self.model:
            raise ProviderConfigurationError(
                self.name,
                "NVIDIA_MODEL is not configured.",
            )

        model = ChatOpenAI(
            base_url=NVIDIA_NIM_BASE_URL,
            api_key=self.api_key,
            model=self.model,
            temperature=temperature,
            request_timeout=120,
            max_retries=0,
        )
        try:
            return await model.ainvoke(prompt)
        except Exception as error:
            raise classify_provider_error(self.name, error) from error
