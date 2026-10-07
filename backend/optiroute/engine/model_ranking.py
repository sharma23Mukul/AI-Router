"""Deterministic, request-aware ranking of models inside one workload tier.

Provider catalogues do not publish comparable quality scores. These hints use
only explicit model-family names, declared output limits, and supplied prices;
unknown models retain their connection order when the evidence is equal.
"""

import re

from optiroute.config import ModelConfig
from optiroute.models import ChatCompletionRequest


def _model_capacity(model_id: str) -> float:
    name = model_id.lower()
    capacity = 0.0
    if re.search(r"(?:^|[/_.-])(?:flash|lite|mini|nano|small|haiku|instant)(?:$|[/_.-])", name):
        capacity -= 1.0
    if re.search(r"(?:^|[/_.-])(?:pro|large|max|ultra|opus|reasoner)(?:$|[/_.-])", name):
        capacity += 1.0
    sizes = [float(value) for value in re.findall(r"(?:^|[/_.-])(\d+(?:\.\d+)?)b(?:$|[/_.-])", name)]
    if sizes:
        capacity += max(-0.8, min(0.8, (max(sizes) - 30) / 90))
    return max(-1.5, min(1.5, capacity))


def _task_affinity(model_id: str, task: str) -> float:
    name = model_id.lower()
    if task == "code" and re.search(r"(?:^|[/_.-])(?:code|coder|codestral|devstral)(?:$|[/_.-])", name):
        return 1.4
    if task == "reasoning" and re.search(r"(?:^|[/_.-])(?:reason|reasoner|thinking|qwq|r1)(?:$|[/_.-])", name):
        return 1.4
    return 0.0


def _task_kind(request: ChatCompletionRequest, complexity: dict) -> str:
    prompt = next((message.content or "" for message in reversed(request.messages) if message.role == "user"), "")
    if re.search(r"\b(?:code|coding|program|function|script|debug|refactor|rust|python|javascript|typescript|sql|api|microservice)\b", prompt, re.I):
        return "code"
    if re.search(r"\b(?:prove|proof|derive|reason|logic|math|equation|theorem|calculate)\b", prompt, re.I):
        return "reasoning"
    if complexity.get("task_type") == "deep reasoning":
        return "reasoning"
    return "general"


def rank_models(
    models: list[ModelConfig], request: ChatCompletionRequest, complexity: dict,
) -> list[ModelConfig]:
    """Rank eligible models; original order resolves genuinely unknown ties."""
    if len(models) < 2:
        return models

    effort = max(0.0, min(1.0, float(complexity.get("score", 0.5))))
    task = _task_kind(request, complexity)
    # Zero is the default for discovered connections, not a known free price.
    known_costs = [m.cost_per_1k_input + m.cost_per_1k_output for m in models]
    compare_cost = all(cost > 0 for cost in known_costs) and max(known_costs) > min(known_costs)
    cheapest = min(known_costs) if compare_cost else 0.0

    def score(model: ModelConfig) -> float:
        value = (effort - 0.5) * 3.0 * _model_capacity(model.id)
        value += _task_affinity(model.id, task)
        if request.max_tokens:
            # All eligible models fit; reward extra room only for long output.
            if request.max_tokens >= 2000:
                value += min(0.3, max(0, model.max_tokens - request.max_tokens) / 20000)
        if compare_cost:
            model_cost = model.cost_per_1k_input + model.cost_per_1k_output
            value += (1.0 - effort) * 0.65 * cheapest / model_cost
        return value

    return sorted(models, key=score, reverse=True)
