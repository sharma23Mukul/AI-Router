import copy
from optiroute.models import ChatCompletionRequest

class ContextPruner:
    """Phase 6: Context pruning."""
    
    TOOL_OUTPUT_THRESHOLD_CHARS = 1000
    
    def has_large_tool_output(self, request: ChatCompletionRequest) -> bool:
        if not request.messages:
            return False
        for msg in request.messages:
            if msg.role == "tool" and msg.content:
                if len(msg.content) > self.TOOL_OUTPUT_THRESHOLD_CHARS:
                    return True
        return False
        
    def prune(self, request: ChatCompletionRequest) -> tuple[ChatCompletionRequest, int]:
        """
        Truncate large tool outputs to save context window tokens and reduce cost.
        Returns the modified request and an estimate of how many tokens were pruned.
        """
        pruned_request = copy.deepcopy(request)
        chars_pruned = 0
        
        for msg in pruned_request.messages:
            if msg.role == "tool" and msg.content:
                if len(msg.content) > self.TOOL_OUTPUT_THRESHOLD_CHARS:
                    original_len = len(msg.content)
                    # Truncate and append a marker
                    msg.content = msg.content[:self.TOOL_OUTPUT_THRESHOLD_CHARS] + "\n...[TRUNCATED BY OPTIROUTE]"
                    chars_pruned += (original_len - self.TOOL_OUTPUT_THRESHOLD_CHARS)
                    
        # Roughly estimate 1 token = 4 chars
        tokens_pruned = max(0, chars_pruned // 4)
        
        return pruned_request, tokens_pruned
