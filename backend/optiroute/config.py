"""
Configuration loading and validation for OptiRoute.

Loads settings from config.yaml and validates them with Pydantic models.
API keys are resolved from environment variables at load time.
"""

import os
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, Field
from dotenv import load_dotenv

# Load environment variables from .env file (if present)
load_dotenv()


# ---------------------------------------------------------------------------
# Pydantic models for config.yaml structure
# ---------------------------------------------------------------------------

class ModelConfig(BaseModel):
    """A single LLM backend model."""
    id: str
    provider: str
    api_base: str
    api_key_env: str = ""
    api_key: Optional[str] = Field(default=None, exclude=True, repr=False)
    cost_per_1k_input: float
    cost_per_1k_output: float
    max_tokens: int = 8192
    supports_function_calling: bool = False
    supports_json_mode: bool = False

    def resolve_api_key(self) -> str:
        """Read the API key from the environment variable named in api_key_env."""
        key = self.api_key or (os.environ.get(self.api_key_env) if self.api_key_env else None)
        if not key:
            raise ValueError(
                f"Environment variable '{self.api_key_env}' is not set "
                f"(required for model '{self.id}')"
            )
        return key


class TierConfig(BaseModel):
    """A tier grouping one or more models of similar capability."""
    description: str = ""
    models: list[ModelConfig] = Field(default_factory=list)


class RoutingRuleConfig(BaseModel):
    """A single routing rule (Phase 1 — structure defined here, logic built later)."""
    name: str = ""
    conditions: dict = Field(default_factory=dict)
    target_tier: str = "light"
    priority: int = 0


class RoutingConfig(BaseModel):
    """Top-level routing settings."""
    default_tier: str = "light"
    rules: list[RoutingRuleConfig] = Field(default_factory=list)


class FailoverConfig(BaseModel):
    """Failover behaviour (Phase 2)."""
    timeout_seconds: float = 30.0
    max_retries: int = 2
    consecutive_failures_to_mark_down: int = 3
    health_check_interval_seconds: float = 60.0


class EscalationConfig(BaseModel):
    """Confidence-based escalation (Phase 3)."""
    max_escalations: int = 2
    enabled: bool = True


class PruningConfig(BaseModel):
    """Context pruning settings (Phase 4)."""
    enabled: bool = True
    max_tool_output_tokens: int = 2000
    strategy: str = "truncate"


class SemanticCacheConfig(BaseModel):
    """Semantic similarity caching sub-config (Phase 5)."""
    enabled: bool = True
    similarity_threshold: float = 0.92
    max_cache_size: int = 1000


class CachingConfig(BaseModel):
    """Caching settings (Phase 5)."""
    enabled: bool = True
    exact_match: bool = True
    semantic: SemanticCacheConfig = Field(default_factory=SemanticCacheConfig)


class BudgetConfig(BaseModel):
    """Budget enforcement (Phase 6)."""
    enabled: bool = True
    default_max_tokens: Optional[int] = None
    default_max_cost_usd: Optional[float] = None
    exceed_action: str = "downgrade"


class ServerConfig(BaseModel):
    """Server settings."""
    host: str = "0.0.0.0"
    port: int = 8000
    api_token: Optional[str] = None


class AppConfig(BaseModel):
    """Root configuration object for the entire application."""
    server: ServerConfig = Field(default_factory=ServerConfig)
    tiers: dict[str, TierConfig] = Field(default_factory=dict)
    routing: RoutingConfig = Field(default_factory=RoutingConfig)
    failover: FailoverConfig = Field(default_factory=FailoverConfig)
    escalation: EscalationConfig = Field(default_factory=EscalationConfig)
    pruning: PruningConfig = Field(default_factory=PruningConfig)
    caching: CachingConfig = Field(default_factory=CachingConfig)
    budgets: BudgetConfig = Field(default_factory=BudgetConfig)

    # ----- Convenience helpers -----

    def get_tier(self, tier_name: str) -> TierConfig:
        """Return the TierConfig for the given tier name, or raise."""
        if tier_name not in self.tiers:
            raise KeyError(
                f"Tier '{tier_name}' not found in config. "
                f"Available tiers: {list(self.tiers.keys())}"
            )
        return self.tiers[tier_name]

    def get_primary_model(self, tier_name: str) -> ModelConfig:
        """Return the first (primary) model in a tier."""
        tier = self.get_tier(tier_name)
        if not tier.models:
            raise ValueError(f"Tier '{tier_name}' has no models configured.")
        return tier.models[0]

    @property
    def tier_order(self) -> list[str]:
        """Return tier names in escalation order: light → mid → heavy."""
        # Explicit order so escalation logic has a deterministic path.
        ordered = []
        for name in ("light", "mid", "heavy"):
            if name in self.tiers:
                ordered.append(name)
        # Append any extra tiers not in the standard three.
        for name in self.tiers:
            if name not in ordered:
                ordered.append(name)
        return ordered

    def next_tier(self, current_tier: str) -> Optional[str]:
        """Return the next tier above *current_tier*, or None if already at top."""
        order = self.tier_order
        try:
            idx = order.index(current_tier)
        except ValueError:
            return None
        if idx + 1 < len(order):
            return order[idx + 1]
        return None


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

_CONFIG_FILENAME = "config.yaml"


def _find_config_file() -> Path:
    """Walk up from the package directory to find config.yaml."""
    # Start from the directory containing this file (optiroute/)
    current = Path(__file__).resolve().parent
    # Check the parent directory (project root) first, then current
    for candidate in [current.parent, current]:
        cfg = candidate / _CONFIG_FILENAME
        if cfg.is_file():
            return cfg
    raise FileNotFoundError(
        f"Could not find '{_CONFIG_FILENAME}' in {current.parent} or {current}. "
        "Please create a config.yaml file (see config.example.yaml)."
    )


def load_config(path: Optional[Path] = None) -> AppConfig:
    """Load and validate the application configuration from a YAML file.

    Parameters
    ----------
    path : Path, optional
        Explicit path to the YAML config file. If *None*, the file is
        located automatically relative to the package directory.

    Returns
    -------
    AppConfig
        Fully validated configuration object.
    """
    if path is None:
        path = _find_config_file()

    with open(path, "r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)

    if not isinstance(raw, dict):
        raise ValueError(f"Config file {path} did not parse as a YAML mapping.")

    return AppConfig(**raw)


# Module-level singleton — initialised lazily by get_config().
_config: Optional[AppConfig] = None


def get_config() -> AppConfig:
    """Return the cached application config (loads on first call)."""
    global _config
    if _config is None:
        _config = load_config()
    return _config


def reload_config(path: Optional[Path] = None) -> AppConfig:
    """Force-reload the configuration from disk."""
    global _config
    _config = load_config(path)
    return _config
