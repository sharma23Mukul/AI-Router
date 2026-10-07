import ast
import re
import logging
from optiroute.config import AppConfig, ModelConfig
from optiroute.models import ChatCompletionRequest, RoutingDecision, ChatCompletionResponse
from optiroute.database import get_model_health
from optiroute.engine.workload import evaluate_workload, clearly_incomplete_code_answer
from optiroute.engine.model_ranking import rank_models

logger = logging.getLogger("optiroute")

class RoutingEngine:
    """Handles complexity evaluation, policies, routing, health, and escalation."""
    
    def __init__(self, config: AppConfig):
        self.config = config

    def evaluate_complexity(self, request: ChatCompletionRequest) -> dict:
        """Estimate the reasoning and execution effort requested by the user."""
        return evaluate_workload(request)

    def apply_policies(self, request: ChatCompletionRequest, complexity: dict) -> None:
        """Step 5: Apply Routing Policies."""
        pass

    def categorize_task(self, prompt: str) -> str:
        """Lightweight task categorization used by the response quality evaluator."""
        prompt_lower = prompt.lower()
        code_keywords = ["def ", "class ", "import ", "function(", "code", "script", "python", "javascript"]
        math_keywords = ["calculate", "solve", "math", "equation", "derivative", "integral"]
        if any(kw in prompt_lower for kw in code_keywords):
            return "code"
        if any(kw in prompt_lower for kw in math_keywords):
            return "math"
        return "factual"

    def route_request(self, request: ChatCompletionRequest, complexity: dict = None, target_tier: str = None) -> tuple[ModelConfig, RoutingDecision]:
        """Step 6: Route to Appropriate Model."""
        tier_name: str
        rule_matched: str
        complexity = complexity or {}

        model_field = request.model.strip().lower()

        if target_tier:
            tier_name = target_tier
            rule_matched = f"escalation_target={target_tier}"
        elif request.tier_override:
            tier_name = request.tier_override
            rule_matched = f"tier_override={tier_name}"
        elif model_field in self.config.tiers:
            tier_name = model_field
            rule_matched = f"explicit_tier={tier_name}"
        elif self._find_model_by_id(model_field) is not None:
            found_tier, found_model = self._find_model_by_id(model_field)
            if not self._supports_request(found_model, request):
                raise ValueError(f"Model '{found_model.id}' cannot satisfy this request's tools, JSON mode, or max_tokens")
            decision = RoutingDecision(
                selected_tier=found_tier,
                selected_model=found_model.id,
                rule_matched=f"explicit_model={found_model.id}",
                complexity_signals=complexity
            )
            return found_model, decision
        else:
            # Complexity-based routing
            score = complexity.get("score", 0.0)
            if score >= 0.7:
                tier_name = "heavy"
                rule_matched = "complexity_routing=heavy"
            elif score >= 0.4:
                tier_name = "mid"
                rule_matched = "complexity_routing=mid"
            else:
                tier_name = self.config.routing.default_tier
                rule_matched = f"complexity_routing=default({tier_name})"

        model_config, selected_tier = self._select_capable_model(tier_name, request, complexity)
        if rule_matched == "complexity_routing=heavy" and selected_tier == "light":
            raise ValueError("This heavy prompt needs a connected medium or heavy model with enough capacity.")
        if selected_tier != tier_name:
            rule_matched += f"; capability_fallback={selected_tier}"
            tier_name = selected_tier
        decision = RoutingDecision(
            selected_tier=tier_name,
            selected_model=model_config.id,
            rule_matched=rule_matched,
            complexity_signals=complexity
        )
        return model_config, decision

    def use_available_model(
        self, model: ModelConfig, decision: RoutingDecision,
        available_ids: set[str] | None,
        request: ChatCompletionRequest | None = None,
    ) -> tuple[ModelConfig, RoutingDecision]:
        """Prefer the requested workload tier, then the nearest capable tier."""
        if (available_ids is None or model.provider != "groq" or model.id in available_ids) and (request is None or self._supports_request(model, request)):
            return model, decision
        tier_order = list(self.config.tier_order)
        target_index = tier_order.index(decision.selected_tier)
        search_order = sorted(range(len(tier_order)), key=lambda index: (abs(index - target_index), -index))
        chosen = None
        tier_name = decision.selected_tier
        for index in search_order:
            name = tier_order[index]
            if (decision.rule_matched.startswith("complexity_routing=heavy")
                    and decision.complexity_signals.get("score", 0.0) >= 0.7
                    and name == "light"):
                continue
            eligible = [candidate for candidate in self.config.tiers[name].models
                        if (available_ids is None or candidate.provider != "groq" or candidate.id in available_ids)
                        and (request is None or self._supports_request(candidate, request))]
            if eligible:
                chosen = rank_models(eligible, request, decision.complexity_signals)[0] if request else eligible[0]
                tier_name = name
                break
        if chosen is None:
            raise ValueError("No connected model is available and capable of satisfying this request")
        decision.rule_matched += f"; available_fallback={chosen.id}"
        decision.selected_tier = tier_name
        decision.selected_model = chosen.id
        return chosen, decision

    @staticmethod
    def _supports_request(model: ModelConfig, request: ChatCompletionRequest) -> bool:
        return (
            (not request.tools or model.supports_function_calling)
            and (not request.response_format or request.response_format.type != "json_object" or model.supports_json_mode)
            and (request.max_tokens is None or request.max_tokens <= model.max_tokens)
        )

    def _select_capable_model(self, tier_name: str, request: ChatCompletionRequest, complexity: dict | None = None) -> tuple[ModelConfig, str]:
        order = self.config.tier_order
        if tier_name not in order:
            raise ValueError(f"Unknown tier '{tier_name}'")
        index = order.index(tier_name)
        # Escalate for capability first; only step down when no stronger tier fits.
        for name in order[index:] + list(reversed(order[:index])):
            eligible = [model for model in self.config.tiers[name].models if self._supports_request(model, request)]
            if eligible:
                return rank_models(eligible, request, complexity or self.evaluate_complexity(request))[0], name
        raise ValueError("No configured model supports this request's tools, JSON mode, or max_tokens")

    async def is_healthy(self, model_id: str) -> bool:
        """Step 7: API Health Check."""
        return await get_model_health(model_id)

    def get_frontier_model(self) -> tuple[ModelConfig, RoutingDecision]:
        """Step 7b: Route to Frontier model."""
        tier_order = self.config.tier_order
        if not tier_order:
            raise ValueError("No tiers configured")
        heaviest_tier = next((name for name in reversed(tier_order) if self.config.tiers[name].models), None)
        if not heaviest_tier:
            raise ValueError("No models connected")
        model_config = self.config.get_primary_model(heaviest_tier)
        decision = RoutingDecision(
            selected_tier=heaviest_tier,
            selected_model=model_config.id,
            rule_matched="frontier_fallback",
        )
        return model_config, decision

    @staticmethod
    def model_identity(model: ModelConfig) -> tuple[str, str, str]:
        """Avoid repeating the same model with the same credential in another tier."""
        return (model.provider, model.id, model.api_key or model.api_key_env)

    def get_fallback_model(
        self, failed_model: ModelConfig, tier_name: str, request: ChatCompletionRequest,
        attempted: set[tuple[str, str, str]] | None = None,
        allowed_tiers: set[str] | None = None,
    ) -> tuple[ModelConfig, RoutingDecision]:
        """Exhaust this tier, then lower tiers, then higher tiers."""
        order = self.config.tier_order
        start = order.index(tier_name)
        search_order = [tier_name] + list(reversed(order[:start])) + order[start + 1:]
        complexity = self.evaluate_complexity(request)
        excluded = set(attempted or ())
        excluded.add(self.model_identity(failed_model))
        for name in search_order:
            if allowed_tiers is not None and name not in allowed_tiers:
                continue
            # A light model is not a useful fallback for a genuinely heavy
            # request, even when every stronger provider is unavailable.
            if complexity.get("score", 0.0) >= 0.7 and name == "light":
                continue
            eligible = [candidate for candidate in self.config.tiers[name].models
                        if self.model_identity(candidate) not in excluded and self._supports_request(candidate, request)]
            if eligible:
                ranked = rank_models(eligible, request, complexity)
                candidate = ranked[0]
                return candidate, RoutingDecision(
                    selected_tier=name, selected_model=candidate.id,
                    rule_matched=f"provider_fallback={candidate.id}",
                )
        raise ValueError("No other connected model can handle this prompt")

    def get_stronger_tier(self, current_tier: str) -> str | None:
        return self.config.next_tier(current_tier)

    async def evaluate_response_quality(self, response: ChatCompletionResponse, request: ChatCompletionRequest, model_config: ModelConfig) -> bool:
        """Step 8a: Low Confidence or Invalid JSON Schema? Returns True if quality is acceptable."""
        
        # In phase 5, if escalation is disabled globally, we skip quality checks
        if not self.config.escalation.enabled:
            return True
            
        prompt = ""
        prompt = next((message.content or "" for message in reversed(request.messages) if message.role == "user"), "")
        category = self.categorize_task(prompt)
        
        content = ""
        if response.choices and response.choices[0].message.content:
            content = response.choices[0].message.content
            
        if not content:
            # If there's no content (e.g. tool call only), we can assume valid or handle differently
            return True

        if category == "code":
            if clearly_incomplete_code_answer(prompt, content):
                logger.info("Code quality check failed: complete code was requested but answer appears partial.")
                return False
            # Code -> parse check (look for python code blocks and ast.parse them)
            # Find python blocks: ```python ... ```
            python_blocks = re.findall(r"```python\n(.*?)\n```", content, re.DOTALL)
            for block in python_blocks:
                try:
                    ast.parse(block)
                except SyntaxError:
                    logger.info("Code quality check failed: SyntaxError in generated Python block.")
                    return False
            return True
            
        elif category == "math":
            # Different valid explanations can contain different example
            # numbers. Comparing every number in two generated answers caused
            # false escalations and unnecessary provider requests.
            return True
                
        else:
            # Factual/creative -> hedging-phrase heuristic
            hedges = [
                "i might be wrong", 
                "as an ai", 
                "it is possible that", 
                "i am not sure", 
                "i don't have access to",
                "i cannot verify",
                "i'm unable to",
                "i do not have"
            ]
            content_lower = content.lower()
            if any(hedge in content_lower for hedge in hedges):
                logger.info("Factual quality check failed: Hedging phrase detected.")
                return False
            return True

    def _find_model_by_id(self, model_id: str) -> tuple[str, ModelConfig] | None:
        """Search all tiers for a model with the given id."""
        for tier_name, tier in self.config.tiers.items():
            for m in tier.models:
                if m.id.lower() == model_id:
                    return tier_name, m
        return None



