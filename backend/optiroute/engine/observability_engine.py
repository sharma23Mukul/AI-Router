from optiroute.config import ModelConfig
from optiroute.models import UsageInfo, RoutingDecision
from optiroute.database import insert_audit_log, update_workflow_spend

class ObservabilityEngine:
    """Logs cost, latency, and route decisions."""
    
    def estimate_cost(self, model_config: ModelConfig, usage: UsageInfo) -> float:
        """
        Estimate the dollar cost of a request based on token counts and
        the model's per-1k-token pricing.
        """
        input_cost = (usage.prompt_tokens / 1000.0) * model_config.cost_per_1k_input
        output_cost = (usage.completion_tokens / 1000.0) * model_config.cost_per_1k_output
        return round(input_cost + output_cost, 8)
        
    async def log_decision(self, decision: RoutingDecision, status_code: int = 200,
                           request_id: str | None = None) -> str:
        """Step 8: Log Cost, Latency & Route (saves to AUDIT_LOGS)."""
        model_id = None if decision.selected_model == "cache" else decision.selected_model
        log_id = await insert_audit_log(
            workflow_id=decision.workflow_id,
            model_id=model_id,
            cache_id=decision.cache_id if hasattr(decision, 'cache_id') else None,
            status_code=status_code,
            latency_ms=decision.latency_ms,
            total_cost=decision.cost_usd,
            request_id=request_id,
        )
        if decision.workflow_id and decision.cost_usd > 0:
            await update_workflow_spend(decision.workflow_id, decision.cost_usd)
        return log_id
