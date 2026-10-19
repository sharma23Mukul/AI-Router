"""Focused checks for request-aware selection within a workload tier."""

from optiroute.config import AppConfig, ModelConfig, TierConfig
from optiroute.engine.routing_engine import RoutingEngine
from optiroute.models import ChatCompletionRequest, ChatMessage


def model(model_id: str, *, max_tokens: int = 8192) -> ModelConfig:
    return ModelConfig(
        id=model_id, provider="groq", api_base="https://example.test",
        cost_per_1k_input=0, cost_per_1k_output=0, max_tokens=max_tokens,
    )


def request(prompt: str, *, max_tokens: int | None = None) -> ChatCompletionRequest:
    return ChatCompletionRequest(
        messages=[ChatMessage(role="user", content=prompt)], max_tokens=max_tokens,
    )


def test_light_work_chooses_efficient_model_in_same_tier():
    config = AppConfig(tiers={"light": TierConfig(models=[model("gemini-2.5-pro"), model("gemini-2.5-flash")])})
    chosen, decision = RoutingEngine(config).route_request(request("What is a cache?"), {"score": 0.16})
    assert decision.selected_tier == "light"
    assert chosen.id == "gemini-2.5-flash"


def test_hard_work_chooses_capable_model_in_same_tier():
    config = AppConfig(tiers={"heavy": TierConfig(models=[model("gemini-2.5-flash"), model("gemini-2.5-pro")])})
    chosen, decision = RoutingEngine(config).route_request(request("Design a fault-tolerant system"), {"score": 0.88})
    assert decision.selected_tier == "heavy"
    assert chosen.id == "gemini-2.5-pro"


def test_code_task_favors_code_specialist_and_preserves_one_model_route():
    models = [model("general-pro"), model("special-coder")]
    config = AppConfig(tiers={"mid": TierConfig(models=models)})
    engine = RoutingEngine(config)
    chosen, _ = engine.route_request(request("Debug this Python function"), {"score": 0.5})
    assert chosen.id == "special-coder"
    config.tiers["mid"].models = models[:1]
    chosen, _ = engine.route_request(request("Debug this Python function"), {"score": 0.5})
    assert chosen.id == "general-pro"


def test_capability_and_provider_fallback_stay_in_tier():
    config = AppConfig(tiers={"heavy": TierConfig(models=[model("model-pro", max_tokens=1024), model("model-coder", max_tokens=8192)])})
    engine = RoutingEngine(config)
    req = request("Build a Rust API", max_tokens=3000)
    chosen, _ = engine.route_request(req, {"score": 0.85})
    assert chosen.id == "model-coder"
    fallback, decision = engine.get_fallback_model(chosen, "heavy", request("Build a Rust API"))
    assert fallback.id == "model-pro"
    assert decision.selected_tier == "heavy"
