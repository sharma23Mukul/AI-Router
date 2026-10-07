"""Cheap, deterministic estimate of the work a chat request asks the model to do.

The latest user instruction drives the score. Prior turns only influence short,
referential follow-ups; a long pasted document is context, not inherently hard.
"""

import re

from optiroute.models import ChatCompletionRequest


def _has(text: str, pattern: str) -> bool:
    return re.search(pattern, text, re.IGNORECASE | re.MULTILINE) is not None


def is_complete_code_request(prompt: str) -> bool:
    """Recognize requests for a finished code deliverable, not code discussion."""
    if _has(prompt, r"\b(?:do not|don't|without|no)\s+(?:provide|write|give|include|show)\b.{0,35}\bcode\b"):
        return False
    asks_for_code = _has(
        prompt,
        r"\b(?:provide|write|create|build|implement|generate|give|make|develop|need|want)\b.{0,100}\b(?:code|program|game|app|application|website|service|script|project)\b",
    )
    full_deliverable = _has(
        prompt,
        r"\b(?:whole|complete|full|entire|working|runnable|ready\s+to\s+(?:run|paste|use)|end.to.end|from\s+scratch|all\s+(?:the|of\s+the)\s+code)\b",
    )
    return asks_for_code and full_deliverable


def clearly_incomplete_code_answer(prompt: str, content: str) -> bool:
    """Catch explicit partial answers; this does not validate code correctness."""
    if not is_complete_code_request(prompt):
        return False
    prose = re.sub(r"```[\s\S]*?```", "", content)[:4000]
    incomplete_claims = (
        r"\b(?:code\s+)?(?:foundation|skeleton|scaffold|pseudocode)\b",
        r"\b(?:you(?:'ll| will| need to)|left for you to)\s+(?:implement|add|complete|finish)\b",
        r"\b(?:omitted|not implemented|not fully functional|not a complete|not a full|beyond the scope)\b",
        r"\b(?:groundwork|starting point)\b.{0,90}\b(?:implement|complete|finish|add)\b",
    )
    if any(re.search(pattern, prose, re.I) for pattern in incomplete_claims):
        return True
    return not bool(re.search(
        r"```[^\n]*\n[\s\S]*?```|\b(?:public\s+(?:class|static)|class\s+\w+|def\s+\w+|function\s+\w+|const\s+\w+\s*=|import\s+\w+)\b",
        content,
        re.I,
    ))


def _task_effort(prompt: str) -> tuple[float, str, list[str]]:
    text = prompt.strip()
    reasons: list[str] = []

    # Action verbs matter more than domain nouns. "What is a distributed system?"
    # is a small explanation; designing one is a substantial reasoning task.
    if _has(text, r"\b(?:hi|hello|hey|thanks|thank you)\b") and len(text.split()) < 8:
        return 0.06, "conversation", ["brief conversation"]
    if _has(text, r"\b(?:define|what is|who is|when was|what does|spell|translate|convert|name|list)\b") and not is_complete_code_request(text) and not _has(
        text, r"\b(?:design|build|implement|develop|debug|fix|analy[sz]e|evaluate|compare|plan|prove|derive|architect|refactor)\b"
    ):
        return 0.16, "lookup", ["direct lookup or transformation"]

    effort = 0.28
    kind = "explanation"
    if _has(text, r"\b(?:design|architect|migration strategy|threat model|security audit|research|prove|derive|formal proof)\b"):
        effort, kind = 0.59, "deep reasoning"
    elif _has(text, r"\b(?:debug|fix|refactor|refine|implement|build|develop|create|write (?:a |an )?(?:function|app|api|script|program)|solve)\b"):
        effort, kind = 0.46, "implementation or problem solving"
    elif _has(text, r"\b(?:analy[sz]e|evaluate|compare|optimi[sz]e|review|diagnose|calculate|plan|recommend)\b"):
        effort, kind = 0.42, "analysis"
    elif _has(text, r"\b(?:write|summari[sz]e|rewrite|rephrase|draft|outline|explain|describe|generate)\b"):
        effort, kind = 0.30, "explanation or writing"
    if _has(text, r"\b(?:write|draft|create|generate)\b.{0,50}\b(?:story|novel|essay|script|article|report)\b"):
        effort, kind = 0.36, "long-form writing"
    reasons.append(kind)
    return effort, kind, reasons


def evaluate_workload(request: ChatCompletionRequest) -> dict:
    users = [m.content or "" for m in request.messages if m.role == "user"]
    prompt = users[-1].strip() if users else ""
    prior = users[-2].strip() if len(users) > 1 else ""
    score, kind, reasons = _task_effort(prompt)

    referential = bool(prior and _has(
        prompt, r"\b(?:it|that|this|above|previous|same|continue|again|also|more|expand|instead)\b"
    ))
    if referential:
        previous_effort, _, _ = _task_effort(prior)
        # A short edit of a hard answer still needs some context, but does not
        # automatically demand the same model as the original creation task.
        score = max(score, previous_effort * 0.85)
        reasons.append("uses the previous task")

    steps = len(re.findall(r"(?:^|\s)(?:\d+[.):]|[-*•])\s+", prompt))
    if steps >= 3:
        score += 0.16
        reasons.append(f"{steps} requested parts")
    elif steps == 2 or len(re.findall(r"\b(?:and then|as well as|in addition|also|plus|after that)\b", prompt, re.I)) >= 2:
        score += 0.08
        reasons.append("multiple requested parts")

    if _has(prompt, r"\b(?:step.by.step|show your reasoning|justify|trade.?offs?|edge cases?|root cause|why does|how would)\b"):
        score += 0.10
        reasons.append("reasoning or trade-offs requested")
    actions = re.findall(
        r"\b(?:analy[sz]e|evaluate|compare|design|build|implement|debug|fix|refactor|refine|test|deploy|migrate|plan)\b",
        prompt, re.I,
    )
    if len(set(action.lower() for action in actions)) >= 2:
        score += 0.10
        reasons.append("multiple substantive actions")
    if _has(prompt, r"\b(?:production.ready|end.to.end|entire (?:system|application|codebase)|full.stack|at scale|high availability|from scratch)\b"):
        score += 0.17
        reasons.append("broad delivery scope")
    if is_complete_code_request(prompt):
        score = max(score, 0.54)
        reasons.append("complete runnable code requested")
        requirements = re.findall(r"\b(?:should|must|need(?:s)? to|also|when|if|and then|as well as)\b", prompt, re.I)
        if len(requirements) >= 4 and len(prompt.split()) >= 60:
            score += 0.18
            reasons.append("many implementation requirements")
        elif len(requirements) >= 2 or len(prompt.split()) >= 60:
            score += 0.08
            reasons.append("several implementation requirements")
    if _has(prompt, r"\b(?:must|ensure|without|while|subject to|given that|under the constraint|using only)\b"):
        score += 0.06
        reasons.append("explicit constraints")
    requested_words = re.search(r"\b(\d[\d,]*)[- ]word\b|\b(\d[\d,]*)\s+words?\b", prompt, re.I)
    if requested_words:
        word_count = int((requested_words.group(1) or requested_words.group(2)).replace(",", ""))
        if word_count >= 1000:
            score += 0.25
            reasons.append(f"{word_count}-word deliverable")
        elif word_count >= 400:
            score += 0.12
            reasons.append(f"{word_count}-word deliverable")

    domains = [
        r"\b(?:frontend|react|vue|angular|css|user interface)\b",
        r"\b(?:backend|server|api|fastapi|endpoint)\b",
        r"\b(?:database|sql|postgres|redis|schema)\b",
        r"\b(?:deploy|docker|kubernetes|infrastructure|cloud)\b",
        r"\b(?:security|authentication|authorization|encryption|vulnerability)\b",
        r"\b(?:machine learning|model training|neural network)\b",
    ]
    domain_count = sum(_has(prompt, pattern) for pattern in domains)
    if domain_count >= 3 and kind != "lookup":
        score += 0.12
        reasons.append(f"spans {domain_count} technical areas")
    elif domain_count == 2 and kind != "lookup":
        score += 0.06
        reasons.append("spans two technical areas")

    # Input size consumes context but should have only a small effect on effort.
    input_chars = sum(len(m.content or "") for m in request.messages)
    if input_chars > 12000:
        score += 0.08
        reasons.append("large conversation context")
    elif input_chars > 4000:
        score += 0.04
        reasons.append("moderate conversation context")
    if request.tools:
        score += 0.07
        reasons.append("tool use required")
    if request.max_tokens and request.max_tokens > 4000:
        score += 0.05
        reasons.append("long response requested")

    score = round(min(score, 1.0), 2)
    category = "heavy" if score >= 0.7 else "mid" if score >= 0.4 else "light"
    return {
        "score": score,
        "category": category,
        "task_type": kind,
        "reasons": reasons,
        "explanation": f"Estimated {category} workload ({score:.2f}): " + "; ".join(reasons),
    }
