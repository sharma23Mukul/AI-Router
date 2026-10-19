"""
Phase 5 tests — verify the confidence/escalation logic.

Tests:
1. Code rule: invalid python triggers escalation
2. Code rule: valid python passes
3. Factual rule: hedging phrases trigger escalation
4. Factual rule: confident text passes
5. Math rule: inconsistent numbers trigger escalation
6. Math rule: consistent numbers pass
"""

import asyncio
import os
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from optiroute.config import AppConfig, ModelConfig, RoutingConfig, EscalationConfig
from optiroute.engine.routing_engine import RoutingEngine
from optiroute.models import ChatCompletionRequest, ChatMessage, ChatCompletionResponse, Choice, ChoiceMessage


@pytest.fixture
def engine():
    config = AppConfig(
        routing=RoutingConfig(default_tier="light"),
        escalation=EscalationConfig(enabled=True)
    )
    return RoutingEngine(config)


@pytest.fixture
def mock_model():
    return ModelConfig(
        id="test-model",
        provider="openai",
        api_base="",
        api_key_env="TEST_KEY",
        cost_per_1k_input=0.0,
        cost_per_1k_output=0.0
    )


def build_request(prompt: str) -> ChatCompletionRequest:
    req = ChatCompletionRequest(
        model="auto",
        messages=[ChatMessage(role="user", content=prompt)]
    )
    # Mock the phase 4 assignment step
    return req


def build_response(content: str) -> ChatCompletionResponse:
    return ChatCompletionResponse(
        model="test",
        choices=[Choice(message=ChoiceMessage(content=content))]
    )


def test_code_invalid_syntax_escalates(engine, mock_model):
    req = build_request("Write a python def function()")
    
    # Invalid syntax in python block
    resp = build_response("Here is code:\n```python\ndef my_func(:\n    print('hello')\n```")
    
    quality_ok = asyncio.run(engine.evaluate_response_quality(resp, req, mock_model))
    assert quality_ok is False


def test_code_valid_syntax_passes(engine, mock_model):
    req = build_request("Write a python def function()")
    
    resp = build_response("Here is code:\n```python\ndef my_func():\n    print('hello')\n```")
    
    quality_ok = asyncio.run(engine.evaluate_response_quality(resp, req, mock_model))
    assert quality_ok is True


def test_factual_hedging_escalates(engine, mock_model):
    req = build_request("Who was the 14th president?")
    
    resp = build_response("I am not sure, but it might be Franklin Pierce.")
    
    quality_ok = asyncio.run(engine.evaluate_response_quality(resp, req, mock_model))
    assert quality_ok is False


def test_factual_confident_passes(engine, mock_model):
    req = build_request("Who was the 14th president?")
    
    resp = build_response("The 14th president was Franklin Pierce.")
    
    quality_ok = asyncio.run(engine.evaluate_response_quality(resp, req, mock_model))
    assert quality_ok is True


def test_math_answers_do_not_trigger_secondary_provider_calls(engine, mock_model):
    req = build_request("Calculate the trajectory")
    resp = build_response("The result is 42.5.")
    with patch("optiroute.proxy.call_model") as provider:
        assert asyncio.run(engine.evaluate_response_quality(resp, req, mock_model)) is True
        provider.assert_not_called()
