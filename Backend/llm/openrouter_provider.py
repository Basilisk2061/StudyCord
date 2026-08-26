"""OpenRouter fallback generation provider."""

from __future__ import annotations

from typing import Any

from langchain_openai import ChatOpenAI

from .base import (
    LLMProvider,
    ProviderConfigurationError,
    classify_provider_error,
)


OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


class OpenRouterProvider(LLMProvider):
    name = "openrouter"

    def __init__(self, *, api_key: str | None, model: str):
        self.api_key = api_key
        self.model = model

    async def generate(self, prompt: Any, *, temperature: float) -> Any:
        if not self.api_key:
            raise ProviderConfigurationError(
                self.name,
                "OPENROUTER_API_KEY is not configured.",
            )

        model = ChatOpenAI(
            base_url=OPENROUTER_BASE_URL,
            api_key=self.api_key,
            model=self.model,
            temperature=temperature,
            request_timeout=120,
            default_headers={
                "HTTP-Referer": "http://localhost:5173",
                "X-Title": "StudyCord",
            },
        )
        try:
            return await model.ainvoke(prompt)
        except Exception as error:
            raise classify_provider_error(self.name, error) from error
