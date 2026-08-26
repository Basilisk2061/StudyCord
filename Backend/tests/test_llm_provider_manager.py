import io
import os
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import AsyncMock, patch


BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from llm.base import LLMProvider, classify_provider_error
from llm.nvidia_provider import NVIDIA_NIM_BASE_URL, NvidiaProvider
from llm.openrouter_provider import OPENROUTER_BASE_URL, OpenRouterProvider
from llm.provider_manager import ProviderManager


class StatusError(Exception):
    def __init__(self, status_code):
        super().__init__(f"HTTP {status_code}")
        self.status_code = status_code


class ControlledProvider(LLMProvider):
    def __init__(self, name, *, response=None, error=None):
        self.name = name
        self.model = f"{name}-model"
        self.response = response
        self.error = error
        self.calls = []

    async def generate(self, prompt, *, temperature):
        self.calls.append((prompt, temperature))
        if self.error is not None:
            raise classify_provider_error(self.name, self.error) from self.error
        return self.response


class ProviderManagerTests(unittest.IsolatedAsyncioTestCase):
    def manager(self, primary, fallback):
        return ProviderManager(
            providers={"nvidia": primary, "openrouter": fallback},
            primary_provider="nvidia",
            fallback_provider="openrouter",
        )

    async def test_nvidia_success_returns_without_openrouter(self):
        nvidia = ControlledProvider("nvidia", response="nvidia-response")
        openrouter = ControlledProvider("openrouter", response="fallback")
        output = io.StringIO()

        with redirect_stdout(output):
            result = await self.manager(nvidia, openrouter).generate(
                "prompt",
                temperature=0.2,
            )

        self.assertEqual(result, "nvidia-response")
        self.assertEqual(nvidia.calls, [("prompt", 0.2)])
        self.assertEqual(openrouter.calls, [])
        self.assertIn("LLM Provider: NVIDIA", output.getvalue())
        self.assertIn("Model: nvidia-model", output.getvalue())
        self.assertRegex(
            output.getvalue(),
            r"Generation Time: \d+\.\d{2} ms",
        )

    async def test_nvidia_timeout_uses_openrouter(self):
        nvidia = ControlledProvider("nvidia", error=TimeoutError("slow"))
        openrouter = ControlledProvider("openrouter", response="fallback")

        result = await self.manager(nvidia, openrouter).generate("prompt")

        self.assertEqual(result, "fallback")
        self.assertEqual(len(nvidia.calls), 1)
        self.assertEqual(len(openrouter.calls), 1)

    async def test_nvidia_429_uses_openrouter_and_logs_reason(self):
        nvidia = ControlledProvider("nvidia", error=StatusError(429))
        openrouter = ControlledProvider("openrouter", response="fallback")
        output = io.StringIO()

        with redirect_stdout(output):
            result = await self.manager(nvidia, openrouter).generate("prompt")

        self.assertEqual(result, "fallback")
        self.assertIn("NVIDIA generation failed.", output.getvalue())
        self.assertIn(
            "Reason: nvidia generation failed (429)",
            output.getvalue(),
        )
        self.assertIn("Switching to OpenRouter...", output.getvalue())
        self.assertIn("LLM Provider: OpenRouter", output.getvalue())
        self.assertIn("Model: openrouter-model", output.getvalue())

    async def test_transient_server_errors_use_openrouter(self):
        for status_code in (500, 502, 503, 504):
            with self.subTest(status_code=status_code):
                nvidia = ControlledProvider(
                    "nvidia",
                    error=StatusError(status_code),
                )
                openrouter = ControlledProvider(
                    "openrouter",
                    response="fallback",
                )
                result = await self.manager(nvidia, openrouter).generate("prompt")
                self.assertEqual(result, "fallback")
                self.assertEqual(len(openrouter.calls), 1)

    async def test_connection_and_quota_failures_use_openrouter(self):
        for error in (
            ConnectionError("network unavailable"),
            RuntimeError("insufficient_quota: quota exceeded"),
        ):
            with self.subTest(error=type(error).__name__):
                nvidia = ControlledProvider("nvidia", error=error)
                openrouter = ControlledProvider(
                    "openrouter",
                    response="fallback",
                )
                result = await self.manager(nvidia, openrouter).generate("prompt")
                self.assertEqual(result, "fallback")
                self.assertEqual(len(openrouter.calls), 1)

    async def test_invalid_key_does_not_fallback(self):
        nvidia = ControlledProvider("nvidia", error=StatusError(401))
        openrouter = ControlledProvider("openrouter", response="fallback")

        with self.assertRaises(Exception) as raised:
            await self.manager(nvidia, openrouter).generate("prompt")

        self.assertFalse(raised.exception.retryable_with_fallback)
        self.assertEqual(openrouter.calls, [])

    async def test_malformed_request_and_programming_error_do_not_fallback(self):
        for error in (StatusError(400), TypeError("programming error")):
            with self.subTest(error=type(error).__name__):
                nvidia = ControlledProvider("nvidia", error=error)
                openrouter = ControlledProvider(
                    "openrouter",
                    response="fallback",
                )
                with self.assertRaises(Exception) as raised:
                    await self.manager(nvidia, openrouter).generate("prompt")
                self.assertFalse(raised.exception.retryable_with_fallback)
                self.assertEqual(openrouter.calls, [])

    async def test_nvidia_provider_uses_openai_compatible_nim_configuration(self):
        response = object()
        with patch("llm.nvidia_provider.ChatOpenAI") as chat_model:
            chat_model.return_value.ainvoke = AsyncMock(return_value=response)
            provider = NvidiaProvider(
                api_key="test-nvidia-key",
                model="test/nim-model",
            )

            result = await provider.generate("prompt", temperature=0.2)

        self.assertIs(result, response)
        chat_model.assert_called_once_with(
            base_url=NVIDIA_NIM_BASE_URL,
            api_key="test-nvidia-key",
            model="test/nim-model",
            temperature=0.2,
            request_timeout=120,
            max_retries=0,
        )

    async def test_openrouter_provider_preserves_existing_configuration(self):
        response = object()
        with patch("llm.openrouter_provider.ChatOpenAI") as chat_model:
            chat_model.return_value.ainvoke = AsyncMock(return_value=response)
            provider = OpenRouterProvider(
                api_key="test-openrouter-key",
                model="openrouter/test-model",
            )

            result = await provider.generate("prompt", temperature=0.3)

        self.assertIs(result, response)
        chat_model.assert_called_once_with(
            base_url=OPENROUTER_BASE_URL,
            api_key="test-openrouter-key",
            model="openrouter/test-model",
            temperature=0.3,
            request_timeout=120,
            default_headers={
                "HTTP-Referer": "http://localhost:5173",
                "X-Title": "StudyCord",
            },
        )

    def test_environment_defaults_to_nvidia_then_openrouter(self):
        with patch.dict(
            os.environ,
            {
                "NVIDIA_API_KEY": "nvidia-key",
                "NVIDIA_MODEL": "nvidia/model",
                "OPENROUTER_API_KEY": "openrouter-key",
                "OPENROUTER_MODEL": "openrouter/model",
            },
            clear=True,
        ):
            manager = ProviderManager.from_environment()

        self.assertEqual(manager.primary_provider, "nvidia")
        self.assertEqual(manager.fallback_provider, "openrouter")
        self.assertEqual(manager.model_for("nvidia"), "nvidia/model")
        self.assertEqual(
            manager.model_for("openrouter"),
            "openrouter/model",
        )


if __name__ == "__main__":
    unittest.main()
