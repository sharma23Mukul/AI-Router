"""
OptiRoute — FastAPI application entry point.

Exposes the OpenAI-compatible POST /v1/chat/completions endpoint.
Phase 0: simple pass-through proxy.
"""

import asyncio
import json
import logging
import time
import httpx
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from optiroute.config import AppConfig, get_config, reload_config
from optiroute.models import ChatCompletionRequest, ChatCompletionResponse, ChatMessage, RoutingDecision
from optiroute.proxy import call_model_with_continuation, available_model_ids, IncompleteResponseError
from optiroute.engine import RoutingEngine, ObservabilityEngine
from optiroute.database import init_db
from optiroute.auth import get_current_user
from optiroute.auth_routes import auth_router
from optiroute.connections import router as connections_router, config_for_user
from optiroute import inflight
from fastapi import Depends
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger("optiroute")
PROMPT_DEADLINE_SECONDS = 180
MODEL_DEADLINE_SECONDS = 90
DEADLINE_MESSAGE = "This prompt took longer than 3 minutes across all model attempts. Please try again or shorten the prompt."


def _progress_model_name(model_id: str) -> str:
    """Use a readable model name in the prompt's live status message."""
    name = model_id.rsplit("/", 1)[-1].replace("-", " ").replace("_", " ")
    acronyms = {"gpt": "GPT", "oss": "OSS", "api": "API", "llm": "LLM"}
    return " ".join(acronyms.get(part.lower(), part.title()) for part in name.split())


def _provider_failure_detail(exc: Exception) -> str:
    if isinstance(exc, IncompleteResponseError):
        return "The model reached its output limit, including continuation attempts."
    if isinstance(exc, httpx.TimeoutException):
        return "The model provider timed out."
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status == 413:
            return "The request was too large for the provider (HTTP 413)."
        if status == 429:
            return "The model provider's rate limit was reached (HTTP 429)."
        if status in (500, 502, 503, 504):
            return f"The model provider is temporarily unavailable (HTTP {status})."
        if status in (401, 403):
            return f"The model provider rejected its API key or access (HTTP {status})."
        if status == 404:
            return "The selected model is not available to this API key (HTTP 404)."
        return f"The model provider rejected the request (HTTP {status})."
    if isinstance(exc, httpx.RequestError):
        return f"Could not connect to the model provider ({type(exc).__name__})."
    return f"The model failed to produce a complete answer ({type(exc).__name__})."


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load config on startup, initialise database, and log the configured tiers."""
    config = get_config()
    tier_summary = {
        name: [m.id for m in tier.models]
        for name, tier in config.tiers.items()
    }
    logger.info("OptiRoute started — tiers: %s", tier_summary)

    # Phase 3: initialise SQLite tables and seed data
    await init_db()
    logger.info("Database initialised (SQLite).")

    yield
    logger.info("OptiRoute shutting down.")


app = FastAPI(
    title="OptiRoute",
    description="LLM routing proxy — routes queries to the cheapest capable model.",
    version="0.1.0",
    lifespan=lifespan,
)

# Allow CORS for the dashboard (Phase 9) and testing.
app.include_router(auth_router)
app.include_router(connections_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Auth middleware (simple bearer token, Constraint C7)
# ---------------------------------------------------------------------------

def _check_auth(authorization: str | None, config: AppConfig) -> None:
    """
    If the config has an api_token set, require a matching Bearer token.
    If api_token is null/empty, auth is disabled (open access).
    """
    expected = config.server.api_token
    if not expected:
        return  # Auth disabled
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header.")
    token = authorization.removeprefix("Bearer ").strip()
    if token != expected:
        raise HTTPException(status_code=403, detail="Invalid API token.")


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    """Simple liveness probe."""
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Core endpoint: POST /v1/chat/completions
# ---------------------------------------------------------------------------

@app.post("/v1/chat/completions")
async def chat_completions(
    request: ChatCompletionRequest,
    authorization: str | None = Header(default=None),
    current_user: dict = Depends(get_current_user)
) -> JSONResponse:
    """Register browser initiated requests so Stop can cancel provider work."""
    request_id = str(request.request_id) if request.request_id else None
    if request_id:
        try:
            inflight.register(current_user["client_id"], request_id)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
    try:
        try:
            return await asyncio.wait_for(
                _run_chat_completion(request, authorization, current_user),
                timeout=PROMPT_DEADLINE_SECONDS,
            )
        except TimeoutError as exc:
            raise HTTPException(status_code=504, detail=DEADLINE_MESSAGE) from exc
    finally:
        if request_id:
            inflight.unregister(current_user["client_id"], request_id)


@app.post("/v1/chat/completions/retry")
async def retry_chat_completion(
    request: ChatCompletionRequest,
    authorization: str | None = Header(default=None),
    current_user: dict = Depends(get_current_user),
) -> JSONResponse:
    """Regenerate a saved answer in the next tier, without cache lookup."""
    if not request.retry_from_chat_id or not request.conversation_id:
        raise HTTPException(status_code=400, detail="A saved answer is required for a heavier retry.")
    return await chat_completions(request, authorization, current_user)


@app.post("/v1/chat/completions/jobs", status_code=202)
@app.post("/v1/chat/completions/retry/jobs", status_code=202)
async def start_chat_completion_job(
    request: ChatCompletionRequest,
    authorization: str | None = Header(default=None),
    current_user: dict = Depends(get_current_user),
):
    """Run a long completion independently of the browser connection."""
    if not request.request_id:
        raise HTTPException(status_code=400, detail="A request ID is required.")
    if request.retry_from_chat_id and not request.conversation_id:
        raise HTTPException(status_code=400, detail="A conversation is required for a heavier retry.")
    request_id = str(request.request_id)
    client_id = current_user["client_id"]

    async def run_job():
        try:
            response = await asyncio.wait_for(
                _run_chat_completion(request, authorization, current_user),
                timeout=PROMPT_DEADLINE_SECONDS,
            )
            inflight.finish(client_id, request_id, json.loads(response.body))
        except asyncio.CancelledError:
            pass
        except TimeoutError:
            inflight.fail(client_id, request_id, DEADLINE_MESSAGE)
        except HTTPException as exc:
            inflight.fail(client_id, request_id, str(exc.detail))
        except Exception as exc:
            logger.exception("Chat job %s failed", request_id)
            inflight.fail(client_id, request_id, f"Request failed ({type(exc).__name__}). Please try again.")
        finally:
            inflight.unregister(client_id, request_id)

    task = asyncio.create_task(run_job())
    try:
        inflight.register(client_id, request_id, task)
    except ValueError as exc:
        task.cancel()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except asyncio.CancelledError as exc:
        task.cancel()
        raise HTTPException(status_code=409, detail="This request was cancelled before it started.") from exc
    return {"request_id": request_id, "status": "running"}


@app.post("/v1/chat/completions/{request_id}/cancel")
async def cancel_chat_completion(request_id: UUID, current_user: dict = Depends(get_current_user)):
    """Cancel the in-flight provider call for this user's request."""
    from optiroute import database as db

    request_key = str(request_id)
    task = inflight.active_task(current_user["client_id"], request_key)
    status = inflight.cancel(current_user["client_id"], request_key)
    if task and task is not asyncio.current_task():
        await asyncio.gather(task, return_exceptions=True)
    await db.discard_cancelled_request(current_user["client_id"], current_user["uid"], request_key)
    return {"status": status}


@app.get("/v1/chat/completions/{request_id}/status")
async def chat_completion_status(request_id: UUID, current_user: dict = Depends(get_current_user)):
    """Report the current model attempt to the user who sent the prompt."""
    return inflight.status(current_user["client_id"], str(request_id))


async def _run_chat_completion(
    request: ChatCompletionRequest,
    authorization: str | None,
    current_user: dict,
) -> JSONResponse:
    """
    OpenAI-compatible chat completions endpoint.
    Implements the exact Phase 4 CFD.
    """
    config, has_connections = await config_for_user(get_config(), current_user["client_id"])
    if not has_connections:
        raise HTTPException(status_code=400, detail="Add a model and API key in Routing Policies before sending prompts.")
    _check_auth(authorization, config)
    from optiroute import database as db
    import uuid as _uuid

    user_message = request.messages[-1] if request.messages else None
    if not user_message or user_message.role != "user" or not (user_message.content or "").strip():
        raise HTTPException(status_code=400, detail="A user prompt is required.")
    user_prompt = user_message.content.strip()
    progress_id = str(request.request_id) if request.request_id else None

    def progress(message: str) -> None:
        inflight.update(current_user["client_id"], progress_id, message)

    def note_error(message: str) -> None:
        inflight.note_error(current_user["client_id"], progress_id, message)

    def ensure_not_cancelled() -> None:
        if inflight.is_cancelled(current_user["client_id"], progress_id):
            raise asyncio.CancelledError()

    progress("Analyzing the task...")
    conversation_id = request.conversation_id or str(_uuid.uuid4())
    previous_turns = []
    retry_tier = None
    parent_chat_id = None
    if request.conversation_id:
        if len(request.messages) != 1 or request.messages[0].role != "user":
            raise HTTPException(status_code=400, detail="Send only the new prompt when continuing a chat.")
        previous_turns = await db.get_conversation_turns(
            conversation_id, current_user["client_id"]
        )
        if not previous_turns:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        turns_by_id = {turn["chat_id"]: turn for turn in previous_turns}
        parents_by_id = {}
        superseded_answers = set()
        previous_id = None
        for turn in previous_turns:
            try:
                turn_meta = json.loads(turn["response"]).get("optiroute", {}) or {}
            except (TypeError, ValueError, AttributeError):
                turn_meta = {}
            if "parent_chat_id" in turn_meta:
                parent = turn_meta["parent_chat_id"]
            elif turn_meta.get("retry_from_chat_id"):
                parent = parents_by_id.get(turn_meta["retry_from_chat_id"])
            else:
                # Chats saved before branching used one chronological path.
                parent = previous_id
            parents_by_id[turn["chat_id"]] = parent
            if turn_meta.get("retry_from_chat_id"):
                superseded_answers.add(turn_meta["retry_from_chat_id"])
            previous_id = turn["chat_id"]

        def context_path(tip_id: str | None) -> list[dict]:
            path = []
            seen = set()
            while tip_id:
                if tip_id in seen or tip_id not in turns_by_id:
                    raise HTTPException(status_code=400, detail="Invalid conversation branch.")
                seen.add(tip_id)
                path.append(turns_by_id[tip_id])
                tip_id = parents_by_id.get(tip_id)
            return list(reversed(path))

        if request.retry_from_chat_id:
            source = turns_by_id.get(request.retry_from_chat_id)
            if not source or source["prompt"] != user_prompt:
                raise HTTPException(status_code=400, detail="The selected answer was not found in this chat.")
            if source["chat_id"] in superseded_answers:
                raise HTTPException(status_code=409, detail="This answer already has a heavier version. Retry that version instead.")
            retry_tier = config.next_tier(source["tier_used"])
            if not retry_tier:
                raise HTTPException(status_code=409, detail="This response is already from the heaviest tier available.")
            if not config.tiers[retry_tier].models:
                raise HTTPException(status_code=409, detail=f"Connect a {retry_tier} tier model to retry this answer.")
            # Regenerate the same turn with the context it originally had.
            # The answer the user rejected must not guide the new model.
            parent_chat_id = parents_by_id.get(source["chat_id"])
            context_turns = context_path(parent_chat_id)
        else:
            parent_chat_id = request.parent_chat_id or previous_turns[-1]["chat_id"]
            if parent_chat_id not in turns_by_id:
                raise HTTPException(status_code=400, detail="The selected answer was not found in this chat.")
            context_turns = context_path(parent_chat_id)
        context_messages = []
        for turn in context_turns[-12:]:
            context_messages.append(ChatMessage(role="user", content=turn["prompt"]))
            try:
                answer = json.loads(turn["response"])["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError, ValueError):
                answer = ""
            context_messages.append(ChatMessage(role="assistant", content=answer or ""))
        request.messages = context_messages + [ChatMessage(role="user", content=user_prompt)]
    elif request.retry_from_chat_id or request.parent_chat_id:
        raise HTTPException(status_code=400, detail="A conversation is required to continue or retry an answer.")
    
    from optiroute.engine import ContextPruner, CacheManager, RoutingEngine, ObservabilityEngine
    pruner = ContextPruner()
    cache_mgr = CacheManager()
    router = RoutingEngine(config)
    obs = ObservabilityEngine()
    
    # Track the active decision
    decision: RoutingDecision | None = None
    cost = 0.0
    latency_ms = 0.0
    quality_ok = True
    
    # 2. Contains large tool output?
    if pruner.has_large_tool_output(request):
        request, tokens_pruned = pruner.prune(request)
    else:
        tokens_pruned = 0

    context_hash = cache_mgr._context_hash(request)
    complexity = router.evaluate_complexity(request)
    router.apply_policies(request, complexity)
    progress("Choosing a model...")
    try:
        planned_model, planned_decision = router.route_request(request, complexity=complexity, target_tier=retry_tier)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if retry_tier and planned_decision.selected_tier != retry_tier:
        raise HTTPException(status_code=409, detail=f"No {retry_tier} tier model can handle this prompt.")

    request_lock = cache_mgr.request_lock(request, current_user["uid"])
    progress("Routing to a heavier model..." if retry_tier else "Checking for a cached answer...")
    async with request_lock:
        ensure_not_cancelled()
        # 3. Semantic cache match?
        cache_match = None if retry_tier else await cache_mgr.check_cache(
            request,
            current_user["client_id"],
            current_user["uid"],
            progress_id,
        )
        ensure_not_cancelled()
        if cache_match:
            cached_response, cache_type, cache_id = cache_match
            # Cache Hit -> step 8
            decision = RoutingDecision(
                selected_tier=(
                    planned_decision.selected_tier
                    if any(model.id == cached_response.model
                           for model in config.tiers[planned_decision.selected_tier].models)
                    else next(
                        (tier for tier, tier_config in config.tiers.items()
                         if any(model.id == cached_response.model for model in tier_config.models)),
                        planned_decision.selected_tier,
                    )
                ),
                selected_model=cached_response.model,
                cache_hit=True,
                cache_type=cache_type,
                cache_id=cache_id,
                tokens_pruned=tokens_pruned,
                workflow_id=await db.ensure_tier_workflow(current_user["client_id"], planned_decision.selected_tier),
                rule_matched=f"cache_hit; {planned_decision.rule_matched}",
                complexity_signals=complexity,
            )
            response = cached_response
            decision.cost_usd = 0.0
            decision.latency_ms = 0.0
        else:
            # The first choice follows this turn's workload and the live Groq catalog.
            progress("Preparing the selected model...")
            available_ids = await available_model_ids(planned_model) if planned_model.provider == "groq" else None
            try:
                planned_model, planned_decision = router.use_available_model(
                    planned_model, planned_decision, available_ids, request
                )
            except ValueError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            if retry_tier and planned_decision.selected_tier != retry_tier:
                raise HTTPException(status_code=409, detail=f"No available {retry_tier} tier model can handle this prompt.")
    
            target_tier = None
            quality_retries = 0
            MAX_QUALITY_RETRIES = 2
            was_escalated = False
            attempted_models: set[tuple[str, str, str]] = set()
            
            while True:
                # 6. Route to Appropriate Model
                if target_tier:
                    model_config, decision = router.route_request(
                        request, complexity=complexity, target_tier=target_tier
                    )
                    try:
                        model_config, decision = router.use_available_model(
                            model_config, decision, available_ids, request
                        )
                    except ValueError as exc:
                        raise HTTPException(status_code=503, detail=str(exc)) from exc
                else:
                    model_config, decision = planned_model, planned_decision
                decision.tokens_pruned = tokens_pruned
                decision.workflow_id = await db.ensure_tier_workflow(current_user["client_id"], decision.selected_tier)
                decision.escalated = was_escalated
                
                # Try each distinct capable model: same tier, lower tiers,
                # then higher tiers. The attempted set bounds the loop.
                failure_note = ""
                generation_request = request
                expanded_output = False
                model_started_at = time.monotonic()
                compacted_for_413 = False
                while True:
                    if not await router.is_healthy(model_config.id):
                        attempted_models.add(router.model_identity(model_config))
                        try:
                            next_model, fallback_decision = router.get_fallback_model(
                                model_config, decision.selected_tier, request, attempted_models,
                                allowed_tiers={retry_tier} if retry_tier else None,
                            )
                        except ValueError as exc:
                            raise HTTPException(status_code=503, detail="No healthy connected model can handle this prompt.") from exc
                        failure_note = f"{_progress_model_name(model_config.id)} is unavailable. Trying {_progress_model_name(next_model.id)}..."
                        note_error(f"{_progress_model_name(model_config.id)} was unavailable.")
                    else:
                        attempted_models.add(router.model_identity(model_config))
                        progress(
                            f"Retrying {_progress_model_name(model_config.id)} with a smaller request..."
                            if compacted_for_413 else f"Generating with {_progress_model_name(model_config.id)}..."
                        )
                        try:
                            remaining = MODEL_DEADLINE_SECONDS - (time.monotonic() - model_started_at)
                            if remaining <= 0:
                                raise TimeoutError("Model time budget exhausted")
                            response, latency_ms = await asyncio.wait_for(
                                call_model_with_continuation(
                                    model_config, generation_request,
                                    lambda part: progress(f"Continuing with {_progress_model_name(model_config.id)}..."),
                                    lambda reason, attempt: (
                                        note_error(f"{_progress_model_name(model_config.id)}: {reason}."),
                                        progress(f"Retrying {_progress_model_name(model_config.id)} after {reason.lower()} (retry {attempt} of 1)..."),
                                    ),
                                ),
                                timeout=remaining,
                            )
                            cost = obs.estimate_cost(model_config, response.usage)
                            break
                        except Exception as exc:
                            ensure_not_cancelled()
                            if (isinstance(exc, httpx.HTTPStatusError)
                                    and exc.response.status_code == 413
                                    and not compacted_for_413):
                                compacted_for_413 = True
                                prior = generation_request.messages[:-1]
                                system = [message for message in prior if message.role == "system"][-1:]
                                recent = [message for message in prior if message.role != "system"][-4:]
                                reduced_tokens = min(generation_request.max_tokens or model_config.max_tokens, 4096)
                                generation_request = generation_request.model_copy(update={
                                    "messages": system + recent + generation_request.messages[-1:],
                                    "max_tokens": reduced_tokens,
                                })
                                note_error(f"{_progress_model_name(model_config.id)} rejected a large request (HTTP 413).")
                                progress(f"Shortening context and retrying {_progress_model_name(model_config.id)}...")
                                continue
                            logger.error("Provider call failed (%s): %s", type(exc).__name__, exc)
                            if isinstance(exc, TimeoutError):
                                note_error(f"{_progress_model_name(model_config.id)} exceeded its 90-second time budget.")
                            else:
                                note_error(f"{_progress_model_name(model_config.id)}: {_provider_failure_detail(exc)}")
                            if not inflight.is_cancelled(current_user["client_id"], progress_id):
                                await db.insert_failed_model_request(
                                    current_user["client_id"], model_config.id,
                                    decision.selected_tier, progress_id
                                )
                            ensure_not_cancelled()
                            incomplete = isinstance(exc, IncompleteResponseError)
                            try:
                                next_model, fallback_decision = router.get_fallback_model(
                                    model_config, decision.selected_tier, request, attempted_models,
                                    allowed_tiers={retry_tier} if retry_tier else None,
                                )
                            except ValueError:
                                detail = f"All eligible connected models failed. Last attempt with {_progress_model_name(model_config.id)}: {_provider_failure_detail(exc)}"
                                raise HTTPException(status_code=502, detail=detail) from exc
                            if incomplete and request.max_tokens is None:
                                expanded_output = True
                            failure_note = (f"{_progress_model_name(model_config.id)} could not finish its answer (token limit). Trying {_progress_model_name(next_model.id)}..."
                                            if incomplete else f"{_progress_model_name(model_config.id)} timed out. Trying {_progress_model_name(next_model.id)}..."
                                            if isinstance(exc, TimeoutError) else f"{_progress_model_name(model_config.id)} failed. Trying {_progress_model_name(next_model.id)}...")
                            logger.warning("Model %s failed. Trying %s.", model_config.id, next_model.id)
                    progress(failure_note)
                    decision.failover_from_model = model_config.id
                    model_config = next_model
                    model_started_at = time.monotonic()
                    compacted_for_413 = False
                    if expanded_output:
                        generation_request = request.model_copy(update={"max_tokens": next_model.max_tokens})
                    decision.selected_model = fallback_decision.selected_model
                    decision.selected_tier = fallback_decision.selected_tier
                    decision.rule_matched = fallback_decision.rule_matched
                    decision.failover_used = True

                # 8a. Low Confidence or Invalid JSON Schema?
                quality_ok = await router.evaluate_response_quality(response, request, model_config)
                if quality_ok:
                    # NO/VALID -> step 8b
                    break
                if retry_tier:
                    # A manual retry targets exactly one tier. Return this as
                    # best effort without replacing the previously cached answer.
                    logger.info("Manual heavier answer appears incomplete; leaving cache unchanged.")
                    break
                    
                # YES/INVALID -> loop back to step 6, re-route to stronger model
                quality_retries += 1
                if quality_retries > MAX_QUALITY_RETRIES:
                    logger.warning("Max quality retries reached. Returning best effort response.")
                    break
                    
                stronger_tier = router.get_stronger_tier(decision.selected_tier)
                if not stronger_tier:
                    logger.warning("Already at highest tier, cannot escalate further for quality.")
                    break
                    
                logger.info(f"Response quality poor. Escalating from {decision.selected_tier} to {stronger_tier}.")
                target_tier = stronger_tier
                was_escalated = True
    
            # 8b. Save to Semantic Cache
            ensure_not_cancelled()
            if retry_tier and (decision.cache_hit or decision.selected_tier != retry_tier):
                raise HTTPException(status_code=502, detail="The heavier retry did not produce a fresh answer from the requested tier.")
            chat_id = str(_uuid.uuid4())
            if quality_ok:
                await cache_mgr.save_cache(
                    request,
                    response,
                    current_user["client_id"],
                    current_user["uid"],
                    progress_id,
                    replace_existing=bool(retry_tier),
                    selected_chat_id=chat_id,
                )
            ensure_not_cancelled()
            
            decision.cost_usd = cost
            decision.latency_ms = round(latency_ms, 2)
    
    if retry_tier and (decision.cache_hit or decision.selected_tier != retry_tier):
        raise HTTPException(status_code=502, detail="The heavier retry did not produce a fresh answer from the requested tier.")

    # Record spend against the tier that ultimately served this turn.
    decision.workflow_id = await db.ensure_tier_workflow(current_user["client_id"], decision.selected_tier)

    # 8. Log Cost, Latency & Route
    ensure_not_cancelled()
    await obs.log_decision(decision, status_code=200, request_id=progress_id)
    ensure_not_cancelled()

    # 9. Return Final Response
    response.optiroute = {
        "tier": decision.selected_tier,
        "model": decision.selected_model,
        "rule_matched": decision.rule_matched,
        "cost_usd": decision.cost_usd,
        "latency_ms": decision.latency_ms,
        "cache_hit": decision.cache_hit,
        "cache_type": decision.cache_type,
        "escalated": decision.escalated,
        "tokens_pruned": decision.tokens_pruned,
        "complexity_score": decision.complexity_signals.get("score", 0.0),
        "recommended_model": planned_model.id if decision.cache_hit else decision.selected_model,
        "explanation": decision.complexity_signals.get("explanation", "")
    }
    if not quality_ok:
        response.optiroute["quality_warning"] = "This answer may be incomplete and was not saved to cache."
    if retry_tier:
        response.optiroute["manual_escalation"] = True
        response.optiroute["retry_from_chat_id"] = request.retry_from_chat_id

    logger.info(
        "Response <- model=%s tokens=%d cost=$%.6f latency=%.0fms",
        decision.selected_model,
        response.usage.total_tokens if response.usage else 0,
        decision.cost_usd,
        decision.latency_ms,
    )

    response.optiroute["conversation_id"] = conversation_id
    response.optiroute["parent_chat_id"] = parent_chat_id
    response.optiroute["turn_index"] = len(previous_turns)
    if decision.cache_hit:
        chat_id = str(_uuid.uuid4())
    response.optiroute["chat_id"] = chat_id
    # A successful turn is persisted before it is returned to the browser.
    title = (user_prompt[:57] + "...") if len(user_prompt) > 60 else user_prompt
    await db.save_chat(
        chat_id=chat_id,
        client_id=current_user["client_id"],
        title=title,
        prompt=user_prompt,
        response_json=response.model_dump_json(exclude_none=True),
        model_used=decision.selected_model or "",
        tier_used=decision.selected_tier or "",
        cost_usd=decision.cost_usd or 0.0,
        latency_ms=decision.latency_ms or 0.0,
        conversation_id=conversation_id,
        turn_index=len(previous_turns),
        context_hash=context_hash,
        request_id=progress_id,
    )

    ensure_not_cancelled()

    return JSONResponse(
        content=response.model_dump(exclude_none=True),
    )


# ---------------------------------------------------------------------------
# Config reload endpoint (useful during development)
# ---------------------------------------------------------------------------

@app.post("/admin/reload-config")
async def admin_reload_config(
    authorization: str | None = Header(default=None),
):
    """Reload configuration from config.yaml without restarting."""
    config = get_config()
    _check_auth(authorization, config)
    new_config = reload_config()
    return {
        "status": "reloaded",
        "tiers": list(new_config.tiers.keys()),
    }



# ---------------------------------------------------------------------------
# Dashboard API Endpoints (Phase 9)
# ---------------------------------------------------------------------------

@app.get("/api/v1/dashboard/overview")
async def api_dashboard_overview(current_user: dict = Depends(get_current_user)):
    """Supports OverviewPage.jsx"""
    from optiroute import database as db
    stats = await db.get_overview_stats(current_user["client_id"])
    # Mock alerts since we don't have an ALERTS table in the ERD
    # The contract expects: { total_requests, cost_saved, cache_hit_rate, active_failovers, alerts: [] }
    # Let's estimate cost_saved based on cache_hits
    db_conn = await db.get_connection()
    try:
        cursor = await db_conn.execute("SELECT COUNT(*) as cnt FROM semantic_cache")
        cache_count = (await cursor.fetchone())["cnt"]
    finally:
        await db_conn.close()
        
    return {
        "total_requests": stats["total_requests"],
        "cost_saved": stats["cache_hit_rate"] * 0.0001, # Rough mock
        "cache_hits": stats["cache_hits"],
        "generated_answers": stats["generated_answers"],
        "cache_hit_rate": stats["cache_hit_rate"],
        "request_recency": stats["request_recency"],
        "active_failovers": stats["active_failovers"],
        "alerts": [] # Empty alerts list as expected by frontend
    }

@app.get("/api/v1/dashboard/requests-per-model")
async def api_requests_per_model(current_user: dict = Depends(get_current_user)):
    """Return the last 24 hourly request counts for connected models."""
    from optiroute import database as db
    return await db.get_requests_per_model(current_user["client_id"])

@app.get("/api/v1/dashboard/weekly-model-requests")
async def api_weekly_model_requests(
    timezone_offset_minutes: int = 0,
    current_user: dict = Depends(get_current_user),
):
    """Return current-month request counts for each model and tier by week."""
    from optiroute import database as db
    return await db.get_weekly_model_requests(
        current_user["client_id"], timezone_offset_minutes
    )

@app.get("/api/v1/policies")
async def api_policies(current_user: dict = Depends(get_current_user)):
    """Supports RoutingPoliciesPage.jsx"""
    from optiroute import database as db
    policies = await db.get_all_policies(current_user["client_id"])
    
    # Contract: [{ policy_id, name, creator_name, allowed_models, budget, current_spend, updated_at }]
    result = []
    for i, p in enumerate(policies):
        result.append({
            "policy_id": p["policy_id"],
            "name": f"Policy {i+1}", # DB only has workflow_id, mock names
            "creator_name": "Admin",
            "allowed_models": p["allowed_models"],
            "budget": p["max_token_budget"],
            "current_spend": 0, # Should come from workflow, keeping simple
            "updated_at": "2026-10-01"
        })
    return result

@app.get("/api/v1/cache")
async def api_cache(current_user: dict = Depends(get_current_user)):
    """Supports SemanticCachePage.jsx"""
    from optiroute import database as db
    entries = await db.get_all_cache_entries(current_user["uid"])
    chat_origins = await db.get_cache_chat_origins(current_user["client_id"])
    origin_by_chat_id = {chat["chat_id"]: chat for chat in chat_origins}
    origin_by_request = {chat["request_id"]: chat for chat in chat_origins if chat["request_id"]}
    origin_by_response = {}
    origin_by_context = {}
    origin_by_prompt = {}
    for chat in chat_origins:
        try:
            response_id = json.loads(chat["response"]).get("id")
        except (TypeError, ValueError):
            response_id = None
        if response_id:
            origin_by_response.setdefault((chat["prompt"], response_id), chat)
        origin_by_context.setdefault((chat["prompt"], chat["context_hash"] or ""), chat)
        origin_by_prompt.setdefault(chat["prompt"], chat)
    
    # Contract: [{ cache_id, query, response_preview, tokens, saved_cost, time, similarity }]
    result = []
    for e in entries:
        query = ""
        similarity = "Exact"
        try:
            # We stored json in prompt_hash
            meta = json.loads(e["prompt_hash"])
            query = meta.get("prompt", "")
            similarity = "Exact key"
        except Exception:
            query = "Unknown Query"
            
        # Try to parse response
        resp_str = e.get("cached_response", "")
        choices = resp_str.get("choices") if isinstance(resp_str, dict) else None
        if not choices or any(choice.get("finish_reason") == "length" for choice in choices):
            continue
        if not any((choice.get("message") or {}).get("content") or
                   (choice.get("message") or {}).get("tool_calls") for choice in choices):
            continue
        response_id = resp_str.get("id") if isinstance(resp_str, dict) else None
        origin = (origin_by_chat_id.get(e.get("selected_chat_id")) or
                  origin_by_request.get(e.get("request_id")) or
                  origin_by_response.get((query, response_id)) or
                  origin_by_context.get((query, e.get("context_hash") or "")) or
                  origin_by_prompt.get(query))
        preview = str(resp_str)[:100]
        if isinstance(resp_str, dict) and resp_str.get("choices"):
            preview = (resp_str["choices"][0].get("message", {}).get("content") or "")[:100]
            
        result.append({
            "cache_id": e["cache_id"],
            "query": query,
            "response_preview": preview + "...",
            "conversation_id": origin["conversation_id"] if origin else None,
            "chat_id": origin["chat_id"] if origin else None,
            "hit_count": e.get("hit_count", 0),
            "saved_cost": 0.001,
            "time": e.get("created_at", "Just now"),
            "similarity": similarity,
            "cache_type": e.get("last_match_type", "exact"),
        })
    return result


@app.delete("/api/v1/cache/{cache_id}")
async def api_delete_cache(cache_id: str, current_user: dict = Depends(get_current_user)):
    from optiroute import database as db
    result = await db.delete_cache_entries(current_user["uid"], current_user["client_id"], [cache_id])
    if cache_id not in result["deleted_ids"]:
        raise HTTPException(status_code=404, detail="Cache entry not found")
    return result


class CacheDeleteSelection(BaseModel):
    cache_ids: list[str]


@app.post("/api/v1/cache/delete-selected")
async def api_delete_selected_cache(selection: CacheDeleteSelection, current_user: dict = Depends(get_current_user)):
    from optiroute import database as db
    if not selection.cache_ids:
        raise HTTPException(status_code=400, detail="Select at least one cache entry")
    return await db.delete_cache_entries(current_user["uid"], current_user["client_id"], selection.cache_ids)

@app.get("/api/v1/budgets")
async def api_budgets(current_user: dict = Depends(get_current_user)):
    """Supports BudgetPage.jsx"""
    from optiroute import database as db
    budgets = await db.get_budget_summary(current_user["client_id"])
    
    # Contract: [{ workflow_name, spent, total, utilized, threshold }]
    result = []
    for b in budgets:
        spent = b["current_spend"]
        total = b["total_budget"] or 1000 # Default if none
        utilized = int((spent / total) * 100) if total > 0 else 0
        result.append({
            "workflow_name": b.get("workflow_name", f"Workflow {b['workflow_id']}"),
            "spent": spent,
            "total": total,
            "utilized": utilized,
            "threshold": 80
        })
    return result


# ---------------------------------------------------------------------------
# Chat History API Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/v1/chats")
async def api_chat_history(q: str = "", current_user: dict = Depends(get_current_user)):
    """Return the user's recent conversations or search all saved turns."""
    from optiroute import database as db
    chats = await db.get_conversations(current_user["client_id"], limit=50, query=q[:200])
    return chats


@app.delete("/api/v1/chats/{chat_id}")
async def api_delete_chat(chat_id: str, current_user: dict = Depends(get_current_user)):
    """Delete an owned conversation and its linked cached answers."""
    from optiroute import database as db
    result = await db.delete_cache_entries(
        current_user["uid"], current_user["client_id"], [], [chat_id]
    )
    if chat_id not in result["deleted_conversation_ids"]:
        raise HTTPException(status_code=404, detail="Chat not found.")
    return result


@app.get("/api/v1/chats/{chat_id}")
async def api_chat_detail(chat_id: str, current_user: dict = Depends(get_current_user)):
    """Return every turn in this user's conversation."""
    from optiroute import database as db
    turns = await db.get_conversation_turns(chat_id, current_user["client_id"])
    if not turns:
        raise HTTPException(status_code=404, detail="Chat not found.")
    from optiroute.engine.cache_manager import CacheManager
    manager = CacheManager()
    entries = await db.get_all_cache_entries(current_user["uid"])
    selected_ids = set()
    for entry in entries:
        try:
            cached_prompt = json.loads(entry["prompt_hash"]).get("prompt", "")
        except (TypeError, ValueError):
            continue
        for turn in turns:
            scope = (turn["context_hash"] or "") if manager._needs_prior_context(turn["prompt"], bool(turn["context_hash"])) else ""
            if scope != entry["context_hash"] or manager._strict_prompt(turn["prompt"]) != manager._strict_prompt(cached_prompt):
                continue
            if entry["selected_chat_id"] == turn["chat_id"]:
                selected_ids.add(turn["chat_id"])
                break
            elif not entry["selected_chat_id"]:
                try:
                    if entry["cached_response"].get("id") == json.loads(turn["response"]).get("id"):
                        selected_ids.add(turn["chat_id"])
                        break
                except (TypeError, ValueError, AttributeError):
                    pass
    return {"chat_id": chat_id, "title": turns[0]["title"], "turns": turns,
            "cached_answer_ids": list(selected_ids)}


class CacheAnswerSelection(BaseModel):
    chat_id: str


@app.post("/api/v1/chats/{conversation_id}/cache-answer")
async def api_select_cached_answer(conversation_id: str, selection: CacheAnswerSelection,
                                   current_user: dict = Depends(get_current_user)):
    """Make one saved answer version the user's cached response for its prompt."""
    from optiroute import database as db
    from optiroute.engine.cache_manager import CacheManager
    turns = await db.get_conversation_turns(conversation_id, current_user["client_id"])
    selected = next((turn for turn in turns if turn["chat_id"] == selection.chat_id), None)
    if not selected:
        raise HTTPException(status_code=404, detail="Answer not found in this chat.")
    try:
        response = ChatCompletionResponse.model_validate_json(selected["response"])
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="This answer cannot be cached.") from exc
    manager = CacheManager()
    if not manager._reusable(response):
        raise HTTPException(status_code=400, detail="This answer is incomplete and cannot be cached.")
    prompt = selected["prompt"]
    context_hash = (selected["context_hash"] or "") if manager._needs_prior_context(prompt, bool(selected["context_hash"])) else ""
    await manager._store_prompt_cache(
        prompt, response, current_user["client_id"], current_user["uid"],
        context_hash, replace_existing=True, selected_chat_id=selection.chat_id,
        pin_selection=True,
    )
    await db.clear_cache_exclusion(current_user["uid"], prompt, context_hash)
    return {"selected_chat_id": selection.chat_id}

