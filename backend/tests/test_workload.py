"""
Phase 8 tests — verify complexity evaluation and routing.
"""

import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from optiroute.engine.routing_engine import RoutingEngine
from optiroute.models import ChatCompletionRequest, ChatMessage
from optiroute.config import AppConfig, get_config

def build_request(prompt: str) -> ChatCompletionRequest:
    return ChatCompletionRequest(
        model="auto",
        messages=[ChatMessage(role="user", content=prompt)]
    )

def test_evaluate_complexity_code():
    engine = RoutingEngine(get_config())
    req = build_request("def hello_world():\n    print('hi')")
    
    comp = engine.evaluate_complexity(req)
    # A tiny code snippet should not automatically require a heavy model.
    assert comp["category"] == "light"
    assert comp["score"] < 0.4

def test_evaluate_complexity_length():
    engine = RoutingEngine(get_config())
    
    # Short
    req1 = build_request("hello")
    comp1 = engine.evaluate_complexity(req1)
    
    # Long
    long_prompt = "hello " * 500
    req2 = build_request(long_prompt)
    comp2 = engine.evaluate_complexity(req2)
    
    assert comp2["score"] > comp1["score"]

def test_complexity_based_routing():
    engine = RoutingEngine(get_config())
    
    # Score < 0.4 -> default (light)
    req_light = build_request("hi")
    comp_light = {"score": 0.3}
    model, decision = engine.route_request(req_light, complexity=comp_light)
    assert decision.selected_tier == "light"
    assert decision.rule_matched.startswith("complexity_routing=default")
    
    # 0.4 <= Score < 0.7 -> mid
    req_mid = build_request("mid task")
    comp_mid = {"score": 0.5}
    model, decision = engine.route_request(req_mid, complexity=comp_mid)
    assert decision.selected_tier == "mid"
    assert decision.rule_matched == "complexity_routing=mid"
    
    # Score >= 0.7 -> heavy
    req_heavy = build_request("heavy task")
    comp_heavy = {"score": 0.8}
    model, decision = engine.route_request(req_heavy, complexity=comp_heavy)
    assert decision.selected_tier == "heavy"
    assert decision.rule_matched == "complexity_routing=heavy"

def test_explicit_tier_overrides_complexity():
    engine = RoutingEngine(get_config())
    
    # Score 0.9 (heavy) but user explicitly requests 'light'
    req = ChatCompletionRequest(
        model="light",
        messages=[ChatMessage(role="user", content="heavy task")]
    )
    comp = {"score": 0.9}
    model, decision = engine.route_request(req, complexity=comp)
    
    assert decision.selected_tier == "light"
    assert decision.rule_matched == "explicit_tier=light"

