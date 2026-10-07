"""
Provider proxy — sends chat completion requests to LLM provider APIs.

This module handles the actual HTTP communication with backend models.
It is deliberately simple in Phase 0 (pass-through to a single model).
Failover, retries, and health tracking are added in Phase 2.
"""

import asyncio
import time
import logging
import re
import hashlib
import random
from typing import Any, Optional

import httpx

from optiroute.config import ModelConfig
from optiroute.models import (
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatMessage,
    Choice,
    ChoiceMessage,
    UsageInfo,
)


# Long timeout for LLM calls — these can be slow for complex prompts.
_DEFAULT_TIMEOUT = 90.0
_model_catalog: dict[str, tuple[float, set[str]]] = {}


class IncompleteResponseError(ValueError):
    """The provider stopped generation at its output token limit."""

    def __init__(self, message: str, partial_response: ChatCompletionResponse | None = None):
        super().__init__(message)
        self.partial_response = partial_response


async def _post_with_retries(client: httpx.AsyncClient, url: str, payload: dict, headers: dict, model_id: str, on_retry=None) -> httpx.Response:
    """Retry transient transport and provider failures; preserve permanent errors."""
    logger = logging.getLogger("optiroute")
    for attempt in range(2):
        try:
            response = await client.post(url, json=payload, headers=headers)
        except httpx.RequestError as exc:
            if attempt == 1:
                raise
            logger.warning("%s transport failure (%s), retry %s/1", model_id, type(exc).__name__, attempt + 1)
            if on_retry:
                on_retry("The provider connection failed", attempt + 1)
            await asyncio.sleep(min(8, 2 ** attempt) + random.uniform(0, 0.5))
            continue
        if response.status_code not in (408, 429, 500, 502, 503, 504) or attempt == 1:
            response.raise_for_status()
            return response
        retry_after = response.headers.get("retry-after", "")
        try:
            delay = min(8.0, max(0.0, float(retry_after)))
        except ValueError:
            delay = min(8, 2 ** attempt) + random.uniform(0, 0.5)
        logger.warning("%s returned HTTP %s, retry %s/1", model_id, response.status_code, attempt + 1)
        if on_retry:
            on_retry(f"The provider returned HTTP {response.status_code}", attempt + 1)
        await asyncio.sleep(delay)
    raise RuntimeError("Provider retry loop ended unexpectedly")


def _requested_word_count(request: ChatCompletionRequest) -> int:
    prompt = next((m.content or "" for m in reversed(request.messages) if m.role == "user"), "")
    match = re.search(r"\b(\d[\d,]*)[- ]word\b|\b(\d[\d,]*)\s+words?\b", prompt, re.I)
    return int((match.group(1) or match.group(2)).replace(",", "")) if match else 0


async def available_model_ids(model_config: ModelConfig) -> set[str] | None:
    """Read the account's Groq catalog, cached for five minutes."""
    global _model_catalog
    now = time.monotonic()
    catalog_key = hashlib.sha256(model_config.resolve_api_key().encode()).hexdigest()
    cached = _model_catalog.get(catalog_key)
    if cached and now < cached[0]:
        return cached[1]
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(
                f"{model_config.api_base.rstrip('/')}/models",
                headers={"Authorization": f"Bearer {model_config.resolve_api_key()}"},
            )
            response.raise_for_status()
        model_ids = {item["id"] for item in response.json().get("data", [])}
        _model_catalog[catalog_key] = (now + 300, model_ids)
        return model_ids
    except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
        logging.getLogger("optiroute").warning("Groq model catalog unavailable: %s", exc)
        return cached[1] if cached else None


async def call_model(
    model_config: ModelConfig,
    request: ChatCompletionRequest,
    on_retry=None,
) -> tuple[ChatCompletionResponse, float]:
    """
    Send a chat completion request to a single LLM backend.

    Parameters
    ----------
    model_config : ModelConfig
        The model to call (includes provider URL, API key env var, etc.).
    request : ChatCompletionRequest
        The incoming request (already validated).

    Returns
    -------
    tuple[ChatCompletionResponse, float]
        The parsed response and the wall-clock latency in milliseconds.

    Raises
    ------
    httpx.HTTPStatusError
        If the provider returns a non-2xx status.
    httpx.TimeoutException
        If the provider doesn't respond in time.
    """
    if model_config.provider == "anthropic":
        return await _call_anthropic(model_config, request, on_retry)

    api_key = model_config.resolve_api_key()
    url = f"{model_config.api_base.rstrip('/')}/chat/completions"

    # Build the request payload in the OpenAI-compatible format.
    payload: dict[str, Any] = {
        "model": model_config.id,
        "messages": [msg.model_dump(exclude_none=True) for msg in request.messages],
    }

    # Pass through optional parameters only if set.
    if request.temperature is not None:
        payload["temperature"] = request.temperature
    if request.top_p is not None:
        payload["top_p"] = request.top_p
    requested_words = _requested_word_count(request)
    if request.max_tokens is not None:
        completion_limit = request.max_tokens
    elif requested_words >= 1000:
        completion_limit = min(model_config.max_tokens, 11200)
    elif requested_words >= 400:
        completion_limit = min(model_config.max_tokens, 9200)
    else:
        completion_limit = min(model_config.max_tokens, 8192)
    token_limit_field = "max_completion_tokens" if model_config.provider in ("groq", "openai") else "max_tokens"
    payload[token_limit_field] = completion_limit
    if requested_words >= 400 and model_config.provider == "groq" and model_config.id.startswith("openai/gpt-oss-"):
        payload["reasoning_effort"] = "low"
    if request.stop is not None:
        payload["stop"] = request.stop
    if request.n != 1:
        payload["n"] = request.n
    if request.tools:
        payload["tools"] = [t.model_dump(exclude_none=True) for t in request.tools]
    if request.tool_choice is not None:
        payload["tool_choice"] = request.tool_choice
    if request.response_format is not None:
        payload["response_format"] = request.response_format.model_dump(exclude_none=True)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    start = time.perf_counter()

    async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as client:
        http_resp = await _post_with_retries(client, url, payload, headers, model_config.id, on_retry)

    latency_ms = (time.perf_counter() - start) * 1000.0
    data = http_resp.json()

    # Parse the provider response into our standard response model.
    response = _parse_provider_response(data, model_config.id)
    if not response.choices or any(choice.finish_reason == "length" for choice in response.choices):
        raise IncompleteResponseError(f"{model_config.id} stopped before completing its answer (token limit)", response)
    if not any(choice.message.content or choice.message.tool_calls for choice in response.choices):
        raise ValueError(f"{model_config.id} returned no displayable answer")
    return response, latency_ms


async def call_model_with_continuation(
    model_config: ModelConfig,
    request: ChatCompletionRequest,
    on_continue=None,
    on_retry=None,
) -> tuple[ChatCompletionResponse, float]:
    """Continue a truncated text response with the same model before failover."""
    if request.tools or request.response_format or request.n != 1:
        return await call_model(model_config, request, on_retry)
    started = time.perf_counter()
    working = request
    combined = ""
    prompt_tokens = 0
    completion_tokens = 0
    for part in range(3):
        try:
            response, _ = await call_model(model_config, working, on_retry)
            limited = False
        except IncompleteResponseError as exc:
            response = exc.partial_response
            if not response or not response.choices or not response.choices[0].message.content:
                raise
            limited = True
        content = response.choices[0].message.content or ""
        if combined:
            # Providers sometimes repeat the last sentence at a continuation boundary.
            overlap = next((n for n in range(min(200, len(combined), len(content)), 19, -1)
                            if combined[-n:] == content[:n]), 0)
            combined += content[overlap:]
        else:
            combined = content
        prompt_tokens += response.usage.prompt_tokens
        completion_tokens += response.usage.completion_tokens
        if not limited:
            response.choices[0].message.content = combined
            response.usage = UsageInfo(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=prompt_tokens + completion_tokens,
            )
            return response, (time.perf_counter() - started) * 1000.0
        if part == 2:
            raise IncompleteResponseError(f"{model_config.id} reached its output limit after three continuation parts")
        if on_continue:
            on_continue(part + 2)
        working = request.model_copy(deep=True)
        working.messages += [
            ChatMessage(role="assistant", content=combined),
            ChatMessage(role="user", content="Continue exactly where your answer stopped. Do not repeat any text already written. Finish the original request."),
        ]
    raise RuntimeError("Continuation loop ended unexpectedly")


async def _call_anthropic(
    model_config: ModelConfig, request: ChatCompletionRequest, on_retry=None
) -> tuple[ChatCompletionResponse, float]:
    """Translate text chat turns to Anthropic's native Messages API."""
    if request.tools or (request.response_format and request.response_format.type == "json_object"):
        raise ValueError("This Anthropic connection does not support tools or JSON mode")
    system = "\n\n".join(message.content for message in request.messages if message.role == "system" and message.content)
    messages = [
        {"role": message.role, "content": message.content}
        for message in request.messages
        if message.role in ("user", "assistant") and message.content
    ]
    if not messages:
        raise ValueError("A user message is required")
    requested_words = _requested_word_count(request)
    limit = request.max_tokens or min(model_config.max_tokens, 11200 if requested_words >= 1000 else 9200 if requested_words >= 400 else 8192)
    payload: dict[str, Any] = {"model": model_config.id, "messages": messages, "max_tokens": limit}
    if system:
        payload["system"] = system
    if request.temperature is not None:
        payload["temperature"] = request.temperature
    if request.top_p is not None:
        payload["top_p"] = request.top_p
    if request.stop:
        payload["stop_sequences"] = request.stop if isinstance(request.stop, list) else [request.stop]
    headers = {
        "x-api-key": model_config.resolve_api_key(),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    start = time.perf_counter()
    async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as client:
        http_resp = await _post_with_retries(client, f"{model_config.api_base.rstrip('/')}/messages", payload, headers, model_config.id, on_retry)
    data = http_resp.json()
    stop_reason = data.get("stop_reason")
    content = "\n".join(
        block.get("text", "") for block in data.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    ).strip()
    if not content:
        raise ValueError(f"{model_config.id} returned no displayable answer")
    usage = data.get("usage") or {}
    prompt_tokens = usage.get("input_tokens", 0) or 0
    completion_tokens = usage.get("output_tokens", 0) or 0
    response = ChatCompletionResponse(
        id=data.get("id", ""), model=model_config.id,
        choices=[Choice(index=0, message=ChoiceMessage(role="assistant", content=content), finish_reason="length" if stop_reason == "max_tokens" else "stop")],
        usage=UsageInfo(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
        ),
    )
    if stop_reason in ("max_tokens", "model_context_window_exceeded"):
        raise IncompleteResponseError(f"{model_config.id} stopped before completing its answer (token limit)", response if stop_reason == "max_tokens" else None)
    return response, (time.perf_counter() - start) * 1000.0


def _parse_provider_response(
    data: dict[str, Any],
    model_id: str,
) -> ChatCompletionResponse:
    """
    Convert a raw JSON response from an OpenAI-compatible provider
    into our ChatCompletionResponse model.
    """
    choices = []
    for raw_choice in data.get("choices", []):
        msg_data = raw_choice.get("message", {})
        choices.append(
            Choice(
                index=raw_choice.get("index", 0),
                message=ChoiceMessage(
                    role=msg_data.get("role", "assistant"),
                    content=msg_data.get("content"),
                    tool_calls=msg_data.get("tool_calls"),
                ),
                finish_reason=(raw_choice.get("finish_reason") or "stop").lower(),
            )
        )

    usage_data = data.get("usage", {})
    usage = UsageInfo(
        prompt_tokens=usage_data.get("prompt_tokens", 0),
        completion_tokens=usage_data.get("completion_tokens", 0),
        total_tokens=usage_data.get("total_tokens", 0),
    )

    return ChatCompletionResponse(
        id=data.get("id", ""),
        object=data.get("object", "chat.completion"),
        created=data.get("created", 0),
        model=model_id,
        choices=choices,
        usage=usage,
    )





