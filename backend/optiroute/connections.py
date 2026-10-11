"""User-owned model connections and provider-safe routing configuration."""

import os
import uuid

import httpx

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from optiroute import database as db
from optiroute.auth import get_current_user
from optiroute.config import AppConfig, ModelConfig


# Fixed endpoints prevent a supplied API key from being sent to an arbitrary URL.
PROVIDER_BASES = {
    "groq": "https://api.groq.com/openai/v1",
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "together": "https://api.together.xyz/v1",
    "fireworks": "https://api.fireworks.ai/inference/v1",
    "mistral": "https://api.mistral.ai/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "anthropic": "https://api.anthropic.com/v1",
}

router = APIRouter(prefix="/api/v1/model-connections", tags=["model connections"])


class ConnectionInput(BaseModel):
    tier: str
    name: str = Field(min_length=1, max_length=80)
    provider: str
    model_id: str = Field(min_length=1, max_length=150)
    api_key: str = Field(min_length=1, max_length=1000)
    max_tokens: int = Field(default=8192, ge=256, le=200000)
    cost_per_1k_input: float = Field(default=0, ge=0)
    cost_per_1k_output: float = Field(default=0, ge=0)


class DiscoverInput(BaseModel):
    provider: str
    api_key: str = Field(min_length=1, max_length=1000)


class ProviderWorkflowInput(DiscoverInput):
    models: dict[str, str]


async def _provider_models(provider: str, api_key: str) -> list[dict]:
    if provider not in PROVIDER_BASES or not api_key.strip():
        raise HTTPException(400, "Choose a supported provider and enter its API key.")
    headers = (
        {"x-api-key": api_key.strip(), "anthropic-version": "2023-06-01"}
        if provider == "anthropic" else {"Authorization": f"Bearer {api_key.strip()}"}
    )
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            response = await client.get(f"{PROVIDER_BASES[provider]}/models", headers=headers)
            response.raise_for_status()
        raw = response.json().get("data", [])
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status in (401, 403):
            raise HTTPException(400, "The provider rejected this API key.") from exc
        if status == 429:
            raise HTTPException(429, "The provider rate-limited model discovery. Try again shortly.") from exc
        raise HTTPException(502, f"The provider could not list models (HTTP {status}).") from exc
    except (httpx.HTTPError, ValueError, AttributeError) as exc:
        raise HTTPException(502, "Could not reach this provider's model catalogue.") from exc
    result = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        model_id = item["id"]
        if any(word in model_id.lower() for word in ("whisper", "embed", "tts", "speech", "guard", "moderation", "image", "dall-e")):
            continue
        reported_limit = item.get("max_completion_tokens") or item.get("max_output_tokens") or item.get("max_tokens")
        max_tokens = min(8192, reported_limit) if isinstance(reported_limit, int) and reported_limit >= 256 else 8192
        result.append({"id": model_id, "name": str(item.get("display_name") or item.get("name") or model_id)[:80], "max_tokens": max_tokens})
    return sorted(result, key=lambda item: item["name"].lower())


async def _verify_chat_model(provider: str, model_id: str, api_key: str) -> None:
    """Confirm a listed model can actually answer a chat request with this key."""
    if provider not in PROVIDER_BASES:
        raise HTTPException(400, "Choose a supported provider.")

    if provider == "anthropic":
        url = f"{PROVIDER_BASES[provider]}/messages"
        headers = {
            "x-api-key": api_key.strip(),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        payload = {
            "model": model_id,
            "max_tokens": 2,
            "messages": [{"role": "user", "content": "Reply OK."}],
        }
    else:
        url = f"{PROVIDER_BASES[provider].rstrip('/')}/chat/completions"
        headers = {"Authorization": f"Bearer {api_key.strip()}", "Content-Type": "application/json"}
        token_field = "max_completion_tokens" if provider in ("groq", "openai") else "max_tokens"
        payload = {
            "model": model_id,
            "messages": [{"role": "user", "content": "Reply OK."}],
            token_field: 2,
        }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Could not verify model '{model_id}' with the provider.") from exc

    if response.is_success:
        return
    if response.status_code in (401, 403):
        raise HTTPException(400, f"The API key cannot use model '{model_id}'. Check its provider permissions.")
    if response.status_code == 404:
        raise HTTPException(400, f"Model '{model_id}' was listed, but the provider could not find it for chat requests with this API key.")
    if response.status_code == 429:
        raise HTTPException(429, f"The provider rate or quota limit was reached while checking '{model_id}'. Wait and try connecting again.")
    try:
        provider_error = response.json().get("error", {}).get("message")
    except (ValueError, AttributeError):
        provider_error = None
    detail = f"The provider rejected the chat check for '{model_id}' (HTTP {response.status_code})."
    if isinstance(provider_error, str) and provider_error:
        detail += f" {provider_error[:300]}"
    raise HTTPException(400, detail)


def _cipher() -> Fernet:
    secret = os.environ.get("WORKFLOW_ENCRYPTION_KEY", "")
    if not secret:
        raise HTTPException(503, "Server owner must set WORKFLOW_ENCRYPTION_KEY before API keys can be saved.")
    try:
        return Fernet(secret.encode())
    except (ValueError, TypeError) as exc:
        raise HTTPException(503, "WORKFLOW_ENCRYPTION_KEY is invalid.") from exc


def _public(row: dict) -> dict:
    return {key: value for key, value in row.items() if key != "encrypted_api_key"}


@router.get("")
async def list_connections(user: dict = Depends(get_current_user)):
    return [_public(row) for row in await db.get_model_connections(user["client_id"])]


@router.post("/discover")
async def discover_models(payload: DiscoverInput, user: dict = Depends(get_current_user)):
    return {"models": await _provider_models(payload.provider, payload.api_key)}


@router.post("/provider-workflow", status_code=201)
async def add_provider_workflow(payload: ProviderWorkflowInput, user: dict = Depends(get_current_user)):
    if set(payload.models) != {"light", "mid", "heavy"} or any(not model_id.strip() for model_id in payload.models.values()):
        raise HTTPException(400, "Choose a model for each tier.")
    catalogue = {model["id"]: model for model in await _provider_models(payload.provider, payload.api_key)}
    if any(model_id not in catalogue for model_id in payload.models.values()):
        raise HTTPException(400, "One of the selected models is unavailable to this API key.")
    # A provider's catalog may contain models that are not enabled for this
    # project or that do not accept chat completions. Verify each chosen model
    # before saving any connections.
    for model_id in dict.fromkeys(payload.models[tier] for tier in ("light", "mid", "heavy")):
        await _verify_chat_model(payload.provider, model_id, payload.api_key)
    cipher = _cipher()
    rows = []
    for tier in ("light", "mid", "heavy"):
        model_id = payload.models[tier]
        rows.append({
            "connection_id": str(uuid.uuid4()), "client_id": user["client_id"],
            "tier": tier, "name": catalogue[model_id]["name"],
            "provider": payload.provider, "model_id": model_id,
            "encrypted_api_key": cipher.encrypt(payload.api_key.strip().encode()).decode(),
            "max_tokens": catalogue[model_id]["max_tokens"],
            "cost_per_1k_input": 0, "cost_per_1k_output": 0,
        })
    await db.create_model_connections(rows)
    return [_public(row) for row in rows]


@router.post("", status_code=201)
async def add_connection(payload: ConnectionInput, user: dict = Depends(get_current_user)):
    if payload.tier not in ("light", "mid", "heavy"):
        raise HTTPException(400, "Choose light, mid, or heavy.")
    if payload.provider not in PROVIDER_BASES:
        raise HTTPException(400, "Unsupported provider.")
    if not payload.api_key.strip() or not payload.model_id.strip() or not payload.name.strip():
        raise HTTPException(400, "Name, model ID, and API key are required.")
    connection = payload.model_dump(exclude={"api_key"})
    connection["connection_id"] = str(uuid.uuid4())
    connection["client_id"] = user["client_id"]
    connection["encrypted_api_key"] = _cipher().encrypt(payload.api_key.strip().encode()).decode()
    await db.create_model_connection(connection)
    return _public(connection)


@router.delete("/{connection_id}", status_code=204)
async def delete_connection(connection_id: str, user: dict = Depends(get_current_user)):
    if not await db.delete_model_connection(connection_id, user["client_id"]):
        raise HTTPException(404, "Model connection not found.")


async def config_for_user(base: AppConfig, client_id: str) -> tuple[AppConfig, bool]:
    """Create a request-local config containing only this user's connected models."""
    rows = await db.get_model_connections(client_id)
    config = base.model_copy(deep=True)
    for tier in config.tiers.values():
        tier.models = []
    cipher = _cipher() if rows else None
    for row in rows:
        try:
            key = cipher.decrypt(row["encrypted_api_key"].encode()).decode()
        except InvalidToken as exc:
            raise HTTPException(503, "Stored API keys cannot be decrypted. Check WORKFLOW_ENCRYPTION_KEY.") from exc
        config.tiers[row["tier"]].models.append(ModelConfig(
            id=row["model_id"], provider=row["provider"],
            api_base=PROVIDER_BASES[row["provider"]], api_key=key,
            cost_per_1k_input=row["cost_per_1k_input"],
            cost_per_1k_output=row["cost_per_1k_output"],
            max_tokens=row["max_tokens"],
            supports_function_calling=row["provider"] != "anthropic",
            supports_json_mode=row["provider"] != "anthropic",
        ))
    return config, bool(rows)
