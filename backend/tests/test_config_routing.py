"""
Phase 0 tests — verify the basic pass-through proxy works.

These tests validate:
1. Config loading and validation
2. Router produces correct decisions for different model/tier inputs
3. Optional end-to-end request round-trip with a configured provider

Run with:  python -m pytest tests/ -v
Live opt-in: set OPTIROUTE_RUN_LIVE_TESTS=1 and the configured provider key.
"""

import asyncio
import json
import os
import sys
import pytest
from pathlib import Path

# Ensure the project root is on the path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from optiroute.config import load_config, AppConfig
from optiroute.models import ChatCompletionRequest, ChatMessage
from optiroute.engine import RoutingEngine


def test_config_loads():
    """Config file loads and validates successfully."""
    config = load_config()
    assert isinstance(config, AppConfig)
    assert "light" in config.tiers
    assert "mid" in config.tiers
    assert "heavy" in config.tiers
    print("✓ Config loads successfully")
    print(f"  Tiers: {list(config.tiers.keys())}")
    for name, tier in config.tiers.items():
        print(f"  {name}: {[m.id for m in tier.models]}")


def test_tier_order():
    """Tier escalation order is light → mid → heavy."""
    config = load_config()
    assert config.tier_order == ["light", "mid", "heavy"]
    assert config.next_tier("light") == "mid"
    assert config.next_tier("mid") == "heavy"
    assert config.next_tier("heavy") is None
    print("✓ Tier order and escalation path correct")


def test_router_default():
    """model='auto' routes to the default tier (light)."""
    config = load_config()
    req = ChatCompletionRequest(
        model="auto",
        messages=[ChatMessage(role="user", content="Hello")],
    )
    router = RoutingEngine(config); model, decision = router.route_request(req)
    assert decision.selected_tier == "light"
    assert model.id == config.get_primary_model("light").id
    assert "complexity_routing=default" in decision.rule_matched
    print(f"✓ model='auto' → tier={decision.selected_tier}, model={model.id}")


def test_router_explicit_tier():
    """model='heavy' routes to the heavy tier."""
    config = load_config()
    req = ChatCompletionRequest(
        model="heavy",
        messages=[ChatMessage(role="user", content="Explain quantum gravity")],
    )
    router = RoutingEngine(config); model, decision = router.route_request(req)
    assert decision.selected_tier == "heavy"
    assert model.id == config.get_primary_model("heavy").id
    print(f"✓ model='heavy' → tier={decision.selected_tier}, model={model.id}")


def test_router_explicit_model():
    """model='gpt-4o' routes directly to that model."""
    config = load_config()
    req = ChatCompletionRequest(
        model=config.get_primary_model("mid").id,
        messages=[ChatMessage(role="user", content="Hello")],
    )
    router = RoutingEngine(config); model, decision = router.route_request(req)
    assert model.id == config.get_primary_model("mid").id
    assert decision.selected_tier == "mid"
    assert "explicit_model" in decision.rule_matched
    print(f"✓ model='gpt-4o' → tier={decision.selected_tier}, model={model.id}")


def test_router_tier_override():
    """tier_override field forces a specific tier."""
    config = load_config()
    req = ChatCompletionRequest(
        model="auto",
        messages=[ChatMessage(role="user", content="Hello")],
        tier_override="heavy",
    )
    router = RoutingEngine(config); model, decision = router.route_request(req)
    assert decision.selected_tier == "heavy"
    assert "tier_override" in decision.rule_matched
    print(f"✓ tier_override='heavy' → tier={decision.selected_tier}, model={model.id}")


@pytest.mark.live
async def test_live_round_trip():
    """
    End-to-end test: send a real request through the configured provider.
    Requires explicit opt-in and that provider's API key.
    """
    if os.environ.get("OPTIROUTE_RUN_LIVE_TESTS") != "1":
        pytest.skip("Set OPTIROUTE_RUN_LIVE_TESTS=1 to opt into provider calls")

    from optiroute.proxy import call_model
    from optiroute.engine import ObservabilityEngine

    config = load_config()
    req = ChatCompletionRequest(
        model="auto",
        messages=[ChatMessage(role="user", content="Say 'OptiRoute works!' and nothing else.")],
        max_tokens=20,
    )

    model_config, decision = RoutingEngine(config).route_request(req)
    if not os.environ.get(model_config.api_key_env):
        pytest.skip(f"Set {model_config.api_key_env} for the configured provider")
    print(f"\n--- Live Round-Trip Test ---")
    print(f"  Routing: tier={decision.selected_tier}, model={model_config.id}")

    response, latency_ms = await call_model(model_config, req)
    obs = ObservabilityEngine(); cost = obs.estimate_cost(model_config, response.usage)

    content = response.choices[0].message.content if response.choices else "(no content)"
    print(f"  Response: {content}")
    print(f"  Tokens: {response.usage.total_tokens}")
    print(f"  Cost: ${cost:.6f}")
    print(f"  Latency: {latency_ms:.0f}ms")
    print(f"✓ Live round-trip successful!")


