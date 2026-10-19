"""
Phase 6 tests — verify Context Pruner logic.
"""

import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from optiroute.engine.context_pruner import ContextPruner
from optiroute.models import ChatCompletionRequest, ChatMessage


def test_no_large_tool_output():
    pruner = ContextPruner()
    req = ChatCompletionRequest(
        model="auto",
        messages=[
            ChatMessage(role="user", content="Hello"),
            ChatMessage(role="tool", content="Small output")
        ]
    )
    
    assert pruner.has_large_tool_output(req) is False
    
    pruned_req, tokens_pruned = pruner.prune(req)
    assert tokens_pruned == 0
    assert pruned_req.messages[1].content == "Small output"


def test_large_tool_output_is_pruned():
    pruner = ContextPruner()
    # Create a 2000 character tool output
    large_content = "A" * 2000
    req = ChatCompletionRequest(
        model="auto",
        messages=[
            ChatMessage(role="user", content="Hello"),
            ChatMessage(role="tool", content=large_content)
        ]
    )
    
    assert pruner.has_large_tool_output(req) is True
    
    pruned_req, tokens_pruned = pruner.prune(req)
    
    # Pruned to 1000 chars, so 1000 chars removed = ~250 tokens
    assert tokens_pruned == 250
    assert len(pruned_req.messages[1].content) > 1000
    assert "...[TRUNCATED BY OPTIROUTE]" in pruned_req.messages[1].content


def test_ignores_large_user_messages():
    pruner = ContextPruner()
    # Create a 2000 character user output
    large_content = "A" * 2000
    req = ChatCompletionRequest(
        model="auto",
        messages=[
            ChatMessage(role="user", content=large_content)
        ]
    )
    
    assert pruner.has_large_tool_output(req) is False
