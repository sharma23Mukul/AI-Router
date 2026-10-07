"""
Pydantic models for the OpenAI-compatible chat completions API.

These define the request and response shapes for POST /v1/chat/completions.
They follow the OpenAI API spec closely enough that existing OpenAI SDK
clients can target OptiRoute as a drop-in proxy.
"""

import time
import uuid
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class ChatMessage(BaseModel):
    """A single message in a chat conversation."""
    role: Literal["system", "user", "assistant", "tool"]
    content: Optional[str] = None
    name: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_calls: Optional[list[dict[str, Any]]] = None


class FunctionDefinition(BaseModel):
    """Schema for a callable function/tool."""
    name: str
    description: Optional[str] = None
    parameters: Optional[dict[str, Any]] = None


class ToolDefinition(BaseModel):
    """Wraps a function definition as a tool."""
    type: str = "function"
    function: FunctionDefinition


class ResponseFormatConfig(BaseModel):
    """Controls the response format (e.g., JSON mode)."""
    type: str = "text"  # "text" or "json_object"


class ChatCompletionRequest(BaseModel):
    """
    Incoming request to POST /v1/chat/completions.

    The `model` field can be:
    - "auto"       → let OptiRoute pick the best tier (Phase 1+)
    - a tier name  → "light", "mid", "heavy" → select within that tier
    - a model id   → "gpt-4o-mini" → use that specific model directly

    Extra OptiRoute-specific fields:
    - workflow_id:  identifies the workflow for budget tracking (Phase 6)
    - tier_override: force a specific tier regardless of routing rules
    """
    model: str = "auto"
    messages: list[ChatMessage]
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    max_tokens: Optional[int] = None
    stream: bool = False
    tools: Optional[list[ToolDefinition]] = None
    tool_choice: Optional[Any] = None
    response_format: Optional[ResponseFormatConfig] = None
    stop: Optional[list[str] | str] = None
    n: int = 1

    # OptiRoute extensions
    workflow_id: Optional[str] = None
    tier_override: Optional[str] = None
    conversation_id: Optional[str] = None
    parent_chat_id: Optional[str] = None
    retry_from_chat_id: Optional[str] = None
    request_id: Optional[UUID] = None


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class ChoiceMessage(BaseModel):
    """The assistant's response message within a choice."""
    role: str = "assistant"
    content: Optional[str] = None
    tool_calls: Optional[list[dict[str, Any]]] = None


class Choice(BaseModel):
    """A single completion choice."""
    index: int = 0
    message: ChoiceMessage
    finish_reason: Optional[str] = "stop"


class UsageInfo(BaseModel):
    """Token usage information."""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ChatCompletionResponse(BaseModel):
    """
    Response from POST /v1/chat/completions.

    Follows the OpenAI response shape so clients can consume it without changes.
    OptiRoute adds extra metadata in the `optiroute` field.
    """
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid.uuid4().hex[:12]}")
    object: str = "chat.completion"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str  # the actual model that served the request
    choices: list[Choice]
    usage: UsageInfo = Field(default_factory=UsageInfo)

    # OptiRoute metadata (not part of standard OpenAI response)
    optiroute: Optional[dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Internal routing context (not sent to clients, used internally)
# ---------------------------------------------------------------------------

class RoutingDecision(BaseModel):
    """
    Records *why* a particular model was chosen for a request.
    Populated by the router and passed through the pipeline so that
    logging (Phase 7) and the dashboard (Phase 9) can display it.
    """
    selected_tier: str
    selected_model: str
    rule_matched: Optional[str] = None
    complexity_signals: dict[str, Any] = Field(default_factory=dict)
    cache_hit: bool = False
    cache_type: Optional[str] = None  # "exact" | "semantic" | None
    cache_id: Optional[str] = None
    escalated: bool = False
    escalation_reason: Optional[str] = None
    escalation_from_model: Optional[str] = None
    failover_used: bool = False
    failover_from_model: Optional[str] = None
    tokens_pruned: int = 0
    cost_usd: float = 0.0
    latency_ms: float = 0.0
    workflow_id: Optional[str] = None
