"""
Database layer for OptiRoute — Phase 3.

Implements the professor-approved ERD as real SQLite tables:
  USER, WORKFLOWS, ROUTING_POLICIES, AUDIT_LOGS, AI_MODELS, SEMANTIC_CACHE

Uses aiosqlite for async access consistent with the FastAPI runtime.
"""

import os
import json
import uuid
import time
import calendar
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Any

import aiosqlite

from optiroute import firestore_persistence as durable

# ---------------------------------------------------------------------------
# Path
# ---------------------------------------------------------------------------

_DB_DIR = Path(os.environ.get("OPTIROUTE_DATA_DIR") or Path(__file__).resolve().parent.parent / "data")
_DB_PATH = _DB_DIR / "optiroute.db"


def _db_path() -> Path:
    """Return (and ensure parent dir exists for) the database file."""
    _DB_DIR.mkdir(parents=True, exist_ok=True)
    return _DB_PATH


# ---------------------------------------------------------------------------
# Schema DDL — matches the approved ERD exactly
# ---------------------------------------------------------------------------

_SCHEMA_SQL = """
-- USER table
CREATE TABLE IF NOT EXISTS users (
    client_id        TEXT PRIMARY KEY,
    api_key_hash     TEXT NOT NULL,
    organization_name TEXT NOT NULL DEFAULT '',
    email            TEXT UNIQUE NOT NULL,
    firebase_uid     TEXT UNIQUE              -- nullable: placeholder rows have NULL
);

-- WORKFLOWS table  (USER "owns" WORKFLOWS 1:N)
CREATE TABLE IF NOT EXISTS workflows (
    workflow_id   TEXT PRIMARY KEY,
    client_id     TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    current_spend REAL NOT NULL DEFAULT 0.0,
    FOREIGN KEY (client_id) REFERENCES users(client_id)
);

CREATE TABLE IF NOT EXISTS model_connections (
    connection_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('light', 'mid', 'heavy')),
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    encrypted_api_key TEXT NOT NULL,
    max_tokens INTEGER NOT NULL DEFAULT 8192,
    cost_per_1k_input REAL NOT NULL DEFAULT 0,
    cost_per_1k_output REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES users(client_id)
);

-- ROUTING_POLICIES table  (WORKFLOWS "configures" ROUTING_POLICIES 1:N)
CREATE TABLE IF NOT EXISTS routing_policies (
    policy_id       TEXT PRIMARY KEY,
    workflow_id     TEXT NOT NULL,
    max_token_budget INTEGER NOT NULL DEFAULT 0,
    allowed_models  TEXT NOT NULL DEFAULT '[]',   -- JSON array of model id strings
    FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
);

-- AI_MODELS table
CREATE TABLE IF NOT EXISTS ai_models (
    model_id          TEXT PRIMARY KEY,
    cost_per_1k_input REAL NOT NULL DEFAULT 0.0,
    provider_name     TEXT NOT NULL DEFAULT '',
    is_healthy        INTEGER NOT NULL DEFAULT 1   -- boolean: 1=healthy, 0=unhealthy
);

-- SEMANTIC_CACHE table  (AI_MODELS "serves" SEMANTIC_CACHE N:1)
CREATE TABLE IF NOT EXISTS semantic_cache (
    cache_id        TEXT PRIMARY KEY,
    prompt_hash     TEXT NOT NULL,
    cached_response TEXT NOT NULL DEFAULT '',       -- JSON-serialised response
    model_id        TEXT,
    hit_count       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    client_id       TEXT,
    owner_uid       TEXT,
    exact_hash      TEXT,
    context_hash    TEXT NOT NULL DEFAULT '',
    last_match_type TEXT NOT NULL DEFAULT 'exact',
    request_id      TEXT,
    selected_chat_id TEXT,
    selection_pinned INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (model_id) REFERENCES ai_models(model_id)
);

CREATE TABLE IF NOT EXISTS cache_exclusions (
    owner_uid    TEXT NOT NULL,
    prompt       TEXT NOT NULL,
    context_hash TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (owner_uid, prompt, context_hash)
);

-- AUDIT_LOGS table  (WORKFLOWS "generates" AUDIT_LOGS 1:N)
-- NOTE: No policy_id — built exactly as the approved diagram shows.
-- See DECISIONS.md entry for reasoning.
CREATE TABLE IF NOT EXISTS audit_logs (
    log_id       TEXT PRIMARY KEY,
    workflow_id  TEXT,
    model_id     TEXT,
    cache_id     TEXT,
    status_code  INTEGER NOT NULL DEFAULT 200,
    latency_ms   REAL NOT NULL DEFAULT 0.0,
    total_cost   REAL NOT NULL DEFAULT 0.0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    request_id   TEXT,
    FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id),
    FOREIGN KEY (model_id)    REFERENCES ai_models(model_id),
    FOREIGN KEY (cache_id)    REFERENCES semantic_cache(cache_id)
);

CREATE TABLE IF NOT EXISTS failed_model_requests (
    event_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    tier TEXT,
    request_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES users(client_id)
);

-- CHAT_HISTORY table  (USER "owns" CHAT_HISTORY 1:N)
CREATE TABLE IF NOT EXISTS chat_history (
    chat_id      TEXT PRIMARY KEY,
    client_id    TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    prompt       TEXT NOT NULL,
    response     TEXT NOT NULL DEFAULT '',       -- JSON-serialised full response
    model_used   TEXT NOT NULL DEFAULT '',
    tier_used    TEXT NOT NULL DEFAULT '',
    cost_usd     REAL NOT NULL DEFAULT 0.0,
    latency_ms   REAL NOT NULL DEFAULT 0.0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    conversation_id TEXT,
    turn_index INTEGER NOT NULL DEFAULT 0,
    context_hash TEXT NOT NULL DEFAULT '',
    request_id TEXT,
    FOREIGN KEY (client_id) REFERENCES users(client_id)
);

-- Indexes for common access patterns
CREATE INDEX IF NOT EXISTS idx_workflows_client      ON workflows(client_id);
CREATE INDEX IF NOT EXISTS idx_model_connections_client ON model_connections(client_id, tier);
CREATE INDEX IF NOT EXISTS idx_policies_workflow     ON routing_policies(workflow_id);
CREATE INDEX IF NOT EXISTS idx_audit_workflow        ON audit_logs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_audit_model           ON audit_logs(model_id);
CREATE INDEX IF NOT EXISTS idx_failed_model_requests_client_time ON failed_model_requests(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cache_prompt_hash     ON semantic_cache(prompt_hash);
CREATE INDEX IF NOT EXISTS idx_chat_history_client   ON chat_history(client_id);
"""


# ---------------------------------------------------------------------------
# Seed data — populates AI_MODELS from config.yaml definitions
# ---------------------------------------------------------------------------

def _seed_ai_models_sql() -> list[tuple[str, ...]]:
    """
    Return INSERT-ready tuples for the three configured models.
    Seeded from config.yaml values so the DB and config stay consistent.
    """
    return [
        ("openai/gpt-oss-20b", 0.00015, "groq", 1),
        ("qwen/qwen3.8-27b",      0.0025,  "groq", 1),
        ("openai/gpt-oss-120b",        0.002,   "groq", 1),
    ]


def _seed_demo_data_sql() -> list[str]:
    """
    Return a list of SQL statements to seed demo/mock data that matches
    the frontend's hardcoded UI (so the API can serve real rows immediately).
    """
    stmts = []

    # --- Default placeholder user ---
    # firebase_uid is NULL. The first user to sign in claims this row and its dashboard data.
    stmts.append(
        "INSERT OR IGNORE INTO users (client_id, api_key_hash, organization_name, email, firebase_uid) "
        "VALUES ('user-demo', 'demo-hash-placeholder', 'OptiRoute Demo Org', 'demo@optiroute.com', NULL);"
    )

    # --- Workflows (matching frontend BudgetPage cards) ---
    workflows = [
        ("wf-a", "user-demo", "Workflow A: High-Complexity Model Usage",  1400.0),
        ("wf-b", "user-demo", "Workflow B: General Assistant Tasks",       600.0),
        ("wf-c", "user-demo", "Workflow C: Fine-Tuning & Custom Training Pipelines", 1800.0),
        ("wf-d", "user-demo", "Workflow D: Batch Evaluation & Embedding Generation",  900.0),
    ]
    for wf_id, cid, name, spend in workflows:
        stmts.append(
            f"INSERT OR IGNORE INTO workflows (workflow_id, client_id, workflow_name, current_spend) "
            f"VALUES ('{wf_id}', '{cid}', '{name}', {spend});"
        )

    # --- Routing Policies (matching RoutingPoliciesPage data) ---
    policies = [
        ("pol-1", "wf-a", 15,   '["qwen/qwen3.8-27b","openai/gpt-oss-20b"]'),
        ("pol-2", "wf-a", 15,   '["qwen/qwen3.8-27b","openai/gpt-oss-20b"]'),
        ("pol-3", "wf-b", 15,   '["qwen/qwen3.8-27b","openai/gpt-oss-20b"]'),
        ("pol-4", "wf-b", 15,   '["qwen/qwen3.8-27b","openai/gpt-oss-20b"]'),
        ("pol-5", "wf-c", 15,   '["qwen/qwen3.8-27b","openai/gpt-oss-20b"]'),
        ("pol-6", "wf-c", 15,   '["qwen/qwen3.8-27b","openai/gpt-oss-20b"]'),
        ("pol-7", "wf-c", 15,   '["qwen/qwen3.8-27b","openai/gpt-oss-20b"]'),
        ("pol-8", "wf-c", 15,   '["qwen/qwen3.8-27b","openai/gpt-oss-20b"]'),
    ]
    for pid, wid, budget, models in policies:
        stmts.append(
            f"INSERT OR IGNORE INTO routing_policies (policy_id, workflow_id, max_token_budget, allowed_models) "
            f"VALUES ('{pid}', '{wid}', {budget}, '{models}');"
        )

    # --- Semantic Cache entries (matching SemanticCachePage data) ---
    cache_entries = [
        ("cache-1", "hash:8F92a", "openai/gpt-oss-20b",
         '{"content":"Token limits are..."}', 14, "2024-05-18 18:12:00"),
        ("cache-2", "hash:7B31c", "openai/gpt-oss-20b",
         '{"content":"Policies define specific rules..."}', 6, "2024-05-18 09:33:00"),
        ("cache-3", "hash:4E09f", "qwen/qwen3.8-27b",
         '{"content":"Resumen del documento..."}', 22, "2024-05-17 14:02:00"),
        ("cache-4", "hash:2D55a", "openai/gpt-oss-20b",
         '{"content":"To optimize vector lookups..."}', 45, "2024-05-17 11:15:00"),
        ("cache-5", "hash:9A12b", "qwen/qwen3.8-27b",
         '{"content":"Tier 3 rate limits allow..."}', 19, "2024-05-16 16:48:00"),
    ]
    for cid, phash, mid, resp, hits, created in cache_entries:
        stmts.append(
            f"INSERT OR IGNORE INTO semantic_cache (cache_id, prompt_hash, model_id, cached_response, hit_count, created_at) "
            f"VALUES ('{cid}', '{phash}', '{mid}', '{resp}', {hits}, '{created}');"
        )

    # --- Audit Log entries (matching OverviewPage alert feed) ---
    audit_entries = [
        ("log-1", "wf-b", "qwen/qwen3.8-27b",      None, 200, 1200.0, 0.0042, "2026-09-20 14:12:05"),
        ("log-2", "wf-a", "openai/gpt-oss-120b",         None, 500, 2100.0, 0.0180, "2026-09-20 14:05:33"),
        ("log-3", "wf-c", "openai/gpt-oss-20b",  None, 200,  450.0, 0.0005, "2026-09-20 13:58:12"),
        ("log-4", "wf-b", "qwen/qwen3.8-27b",       None, 200,  800.0, 0.0030, "2026-09-20 13:42:01"),
        ("log-5", "wf-b", "qwen/qwen3.8-27b",       None, 200,  750.0, 0.0028, "2026-09-20 13:42:01"),
    ]
    for lid, wid, mid, cid, status, lat, cost, created in audit_entries:
        cache_val = f"'{cid}'" if cid else "NULL"
        stmts.append(
            f"INSERT OR IGNORE INTO audit_logs (log_id, workflow_id, model_id, cache_id, status_code, latency_ms, total_cost, created_at) "
            f"VALUES ('{lid}', '{wid}', '{mid}', {cache_val}, {status}, {lat}, {cost}, '{created}');"
        )

    return stmts


# ---------------------------------------------------------------------------
# Async database access
# ---------------------------------------------------------------------------

async def get_connection() -> aiosqlite.Connection:
    """Open a connection to the SQLite database."""
    db = await aiosqlite.connect(str(_db_path()))
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    return durable.wrap(db, _db_path())


def _response_content(response_json: str) -> str | None:
    """Compare the answer itself; chat history adds routing metadata later."""
    try:
        return json.loads(response_json)["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError, ValueError):
        return None


async def _claim_legacy_cache_entries(db: aiosqlite.Connection) -> None:
    """Recover pre-ownership cache rows only when one user's chat proves ownership."""
    cursor = await db.execute(
        "SELECT h.client_id, u.firebase_uid, h.prompt, h.response "
        "FROM chat_history h JOIN users u ON u.client_id = h.client_id "
        "WHERE u.firebase_uid IS NOT NULL"
    )
    owners: dict[tuple[str, str], set[tuple[str, str]]] = {}
    for client_id, owner_uid, prompt, response in await cursor.fetchall():
        content = _response_content(response)
        if content is not None:
            owners.setdefault((prompt, content), set()).add((client_id, owner_uid))

    cursor = await db.execute(
        "SELECT cache_id, prompt_hash, cached_response FROM semantic_cache "
        "WHERE owner_uid IS NULL"
    )
    for cache_id, prompt_hash, cached_response in await cursor.fetchall():
        try:
            metadata = json.loads(prompt_hash)
        except (TypeError, ValueError):
            continue
        if not isinstance(metadata, dict) or not metadata.get("prompt"):
            continue
        content = _response_content(cached_response)
        matches = owners.get((metadata["prompt"], content), set()) if content is not None else set()
        if len(matches) != 1:
            continue
        client_id, owner_uid = next(iter(matches))
        await db.execute(
            "UPDATE OR IGNORE semantic_cache SET client_id = ?, owner_uid = ?, exact_hash = ? "
            "WHERE cache_id = ? AND owner_uid IS NULL",
            (client_id, owner_uid, metadata.get("normalized_hash") or metadata.get("hash"), cache_id),
        )


async def init_db() -> None:
    """Create all tables (if not existing) and seed initial data."""
    await durable.restore_before_init(_db_path())
    db = await get_connection()
    try:
        # Create schema
        await db.executescript(_SCHEMA_SQL)

        # Migrate existing databases without disturbing their cached rows.
        cache_columns = {
            row[1] for row in await (await db.execute("PRAGMA table_info(semantic_cache)")).fetchall()
        }
        if "client_id" not in cache_columns:
            await db.execute("ALTER TABLE semantic_cache ADD COLUMN client_id TEXT")
        if "owner_uid" not in cache_columns:
            await db.execute("ALTER TABLE semantic_cache ADD COLUMN owner_uid TEXT")
        if "exact_hash" not in cache_columns:
            await db.execute("ALTER TABLE semantic_cache ADD COLUMN exact_hash TEXT")
        if "last_match_type" not in cache_columns:
            await db.execute(
                "ALTER TABLE semantic_cache ADD COLUMN last_match_type TEXT NOT NULL DEFAULT 'exact'"
            )
        if "context_hash" not in cache_columns:
            await db.execute(
                "ALTER TABLE semantic_cache ADD COLUMN context_hash TEXT NOT NULL DEFAULT ''"
            )
        if "request_id" not in cache_columns:
            await db.execute("ALTER TABLE semantic_cache ADD COLUMN request_id TEXT")
        if "selected_chat_id" not in cache_columns:
            await db.execute("ALTER TABLE semantic_cache ADD COLUMN selected_chat_id TEXT")
        if "selection_pinned" not in cache_columns:
            await db.execute("ALTER TABLE semantic_cache ADD COLUMN selection_pinned INTEGER NOT NULL DEFAULT 0")
        chat_columns = {
            row[1] for row in await (await db.execute("PRAGMA table_info(chat_history)")).fetchall()
        }
        if "conversation_id" not in chat_columns:
            await db.execute("ALTER TABLE chat_history ADD COLUMN conversation_id TEXT")
        if "turn_index" not in chat_columns:
            await db.execute("ALTER TABLE chat_history ADD COLUMN turn_index INTEGER NOT NULL DEFAULT 0")
        if "context_hash" not in chat_columns:
            await db.execute("ALTER TABLE chat_history ADD COLUMN context_hash TEXT NOT NULL DEFAULT ''")
        if "request_id" not in chat_columns:
            await db.execute("ALTER TABLE chat_history ADD COLUMN request_id TEXT")
        audit_columns = {
            row[1] for row in await (await db.execute("PRAGMA table_info(audit_logs)")).fetchall()
        }
        if "request_id" not in audit_columns:
            await db.execute("ALTER TABLE audit_logs ADD COLUMN request_id TEXT")
        failed_columns = {
            row[1] for row in await (await db.execute("PRAGMA table_info(failed_model_requests)")).fetchall()
        }
        if "tier" not in failed_columns:
            await db.execute("ALTER TABLE failed_model_requests ADD COLUMN tier TEXT")
        await db.execute(
            "UPDATE chat_history SET conversation_id = chat_id "
            "WHERE conversation_id IS NULL OR conversation_id = ''"
        )
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_conversation "
            "ON chat_history(client_id, conversation_id, turn_index)"
        )
        # Use the verified Firebase UID as the isolation key, independent of any
        # client/workflow provisioning or demo-user claim behavior.
        await db.execute("DROP INDEX IF EXISTS idx_cache_user_exact")
        await db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_cache_user_exact "
            "ON semantic_cache(owner_uid, context_hash, exact_hash) "
            "WHERE owner_uid IS NOT NULL AND exact_hash IS NOT NULL"
        )

        await _claim_legacy_cache_entries(db)

        # Seed AI_MODELS
        for model_id, cost, provider, healthy in _seed_ai_models_sql():
            await db.execute(
                "INSERT OR IGNORE INTO ai_models (model_id, cost_per_1k_input, provider_name, is_healthy) "
                "VALUES (?, ?, ?, ?)",
                (model_id, cost, provider, healthy),
            )

        # Seed demo data
        for stmt in _seed_demo_data_sql():
            await db.execute(stmt)

        await db.commit()
    finally:
        await db.close()


# ---------------------------------------------------------------------------
# Query helpers — used by the API layer (Phase 9)
# ---------------------------------------------------------------------------

async def get_all_workflows(client_id: str) -> list[dict]:
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT workflow_id, client_id, workflow_name, current_spend FROM workflows WHERE client_id = ?",
            (client_id,)
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def get_model_connections(client_id: str) -> list[dict]:
    connection = await get_connection()
    try:
        cursor = await connection.execute(
            "SELECT * FROM model_connections WHERE client_id = ? ORDER BY created_at, rowid",
            (client_id,),
        )
        return [dict(row) for row in await cursor.fetchall()]
    finally:
        await connection.close()


async def create_model_connection(item: dict) -> None:
    connection = await get_connection()
    try:
        await connection.execute(
            "INSERT INTO model_connections (connection_id, client_id, tier, name, provider, "
            "model_id, encrypted_api_key, max_tokens, cost_per_1k_input, cost_per_1k_output) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            tuple(item[key] for key in (
                "connection_id", "client_id", "tier", "name", "provider", "model_id",
                "encrypted_api_key", "max_tokens", "cost_per_1k_input", "cost_per_1k_output"
            )),
        )
        await connection.execute(
            "INSERT OR IGNORE INTO ai_models (model_id, provider_name) VALUES (?, ?)",
            (item["model_id"], item["provider"]),
        )
        await connection.commit()
    finally:
        await connection.close()


async def create_model_connections(items: list[dict]) -> None:
    """Save one provider key for multiple tiers as a single transaction."""
    connection = await get_connection()
    try:
        for item in items:
            await connection.execute(
                "INSERT INTO model_connections (connection_id, client_id, tier, name, provider, "
                "model_id, encrypted_api_key, max_tokens, cost_per_1k_input, cost_per_1k_output) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                tuple(item[key] for key in (
                    "connection_id", "client_id", "tier", "name", "provider", "model_id",
                    "encrypted_api_key", "max_tokens", "cost_per_1k_input", "cost_per_1k_output"
                )),
            )
            await connection.execute(
                "INSERT OR IGNORE INTO ai_models (model_id, provider_name) VALUES (?, ?)",
                (item["model_id"], item["provider"]),
            )
        await connection.commit()
    except Exception:
        await connection.rollback()
        raise
    finally:
        await connection.close()


async def delete_model_connection(connection_id: str, client_id: str) -> bool:
    connection = await get_connection()
    try:
        cursor = await connection.execute(
            "DELETE FROM model_connections WHERE connection_id = ? AND client_id = ?",
            (connection_id, client_id),
        )
        await connection.commit()
        return cursor.rowcount > 0
    finally:
        await connection.close()


async def get_all_policies(client_id: str) -> list[dict]:
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT p.policy_id, p.workflow_id, p.max_token_budget, p.allowed_models "
            "FROM routing_policies p "
            "JOIN workflows w ON p.workflow_id = w.workflow_id "
            "WHERE w.client_id = ?",
            (client_id,)
        )
        rows = await cursor.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["allowed_models"] = json.loads(d["allowed_models"])
            result.append(d)
        return result
    finally:
        await db.close()


async def get_all_ai_models() -> list[dict]:
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT model_id, cost_per_1k_input, provider_name, is_healthy FROM ai_models"
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def get_model_health(model_id: str) -> bool:
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT is_healthy FROM ai_models WHERE model_id = ?", (model_id,)
        )
        row = await cursor.fetchone()
        return bool(row["is_healthy"]) if row else False
    finally:
        await db.close()


async def set_model_health(model_id: str, is_healthy: bool) -> None:
    db = await get_connection()
    try:
        await db.execute(
            "UPDATE ai_models SET is_healthy = ? WHERE model_id = ?",
            (1 if is_healthy else 0, model_id),
        )
        await db.commit()
    finally:
        await db.close()


async def get_all_cache_entries(owner_uid: str) -> list[dict]:
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT cache_id, prompt_hash, cached_response, model_id, hit_count, "
            "created_at, last_match_type, context_hash, request_id, selected_chat_id, selection_pinned "
            "FROM semantic_cache WHERE owner_uid = ? ORDER BY created_at DESC",
            (owner_uid,),
        )
        rows = await cursor.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try:
                d["cached_response"] = json.loads(d["cached_response"])
            except (json.JSONDecodeError, TypeError):
                pass
            result.append(d)
        return result
    finally:
        await db.close()


async def delete_cache_entries(
    owner_uid: str, client_id: str, cache_ids: list[str],
    conversation_ids: list[str] | None = None,
) -> dict:
    """Delete owned conversations and their cache entries in one transaction."""
    db = await get_connection()
    try:
        await db.execute("BEGIN IMMEDIATE")
        cache_rows = [dict(row) for row in await (await db.execute(
            "SELECT cache_id, prompt_hash, cached_response, exact_hash, context_hash, request_id, selected_chat_id "
            "FROM semantic_cache WHERE owner_uid = ?", (owner_uid,),
        )).fetchall()]
        chat_rows = [dict(row) for row in await (await db.execute(
            "SELECT chat_id, request_id, conversation_id, prompt, response, context_hash "
            "FROM chat_history WHERE client_id = ? ORDER BY rowid", (client_id,),
        )).fetchall()]
        chats_by_id = {row["chat_id"]: row for row in chat_rows}
        chats_by_request = {row["request_id"]: row for row in chat_rows if row["request_id"]}

        def origin(entry):
            direct = chats_by_id.get(entry["selected_chat_id"])
            if direct:
                return direct
            direct = chats_by_request.get(entry["request_id"])
            if direct:
                return direct
            try:
                prompt = json.loads(entry["prompt_hash"]).get("prompt")
            except (TypeError, ValueError):
                prompt = None
            if not prompt:
                return None
            try:
                response_id = json.loads(entry["cached_response"]).get("id")
            except (TypeError, ValueError):
                response_id = None
            candidates = [row for row in chat_rows if row["prompt"] == prompt
                          and (row["context_hash"] or "") == (entry["context_hash"] or "")]
            if response_id:
                for row in candidates:
                    try:
                        if json.loads(row["response"]).get("id") == response_id:
                            return row
                    except (TypeError, ValueError):
                        pass
                return None
            return candidates[0] if len(candidates) == 1 else None

        selected = set(cache_ids)
        owned_conversations = {row["conversation_id"] for row in chat_rows}
        conversations = set(conversation_ids or []) & owned_conversations
        conversations.update({
            chat["conversation_id"] for entry in cache_rows
            if entry["cache_id"] in selected
            if (chat := origin(entry)) is not None
        })
        from optiroute.engine.cache_manager import CacheManager
        manager = CacheManager()
        deleted_turn_keys = {
            (
                manager._exact_hash(row["prompt"]),
                (row["context_hash"] or "") if manager._needs_prior_context(
                    row["prompt"], bool(row["context_hash"])
                ) else "",
            )
            for row in chat_rows if row["conversation_id"] in conversations
        }
        deleted = []
        for entry in cache_rows:
            chat = origin(entry)
            try:
                prompt = json.loads(entry["prompt_hash"]).get("prompt")
            except (TypeError, ValueError):
                prompt = None
            cache_key = (
                entry["exact_hash"] or (manager._exact_hash(prompt) if prompt else None),
                entry["context_hash"] or "",
            )
            if entry["cache_id"] not in selected and (
                chat is None or chat["conversation_id"] not in conversations
            ) and cache_key not in deleted_turn_keys:
                continue
            if prompt:
                await db.execute(
                    "INSERT OR IGNORE INTO cache_exclusions (owner_uid, prompt, context_hash) "
                    "VALUES (?, ?, ?)",
                    (owner_uid, prompt, entry["context_hash"] or ""),
                )
            await db.execute("UPDATE audit_logs SET cache_id = NULL WHERE cache_id = ?", (entry["cache_id"],))
            await db.execute(
                "DELETE FROM semantic_cache WHERE owner_uid = ? AND cache_id = ?",
                (owner_uid, entry["cache_id"]),
            )
            deleted.append(entry["cache_id"])
        for conversation_id in conversations:
            await db.execute(
                "DELETE FROM chat_history WHERE client_id = ? AND conversation_id = ?",
                (client_id, conversation_id),
            )
        await db.commit()
        return {"deleted_ids": deleted, "deleted_conversation_ids": list(conversations)}
    except Exception:
        await db.rollback()
        raise
    finally:
        await db.close()


async def get_cache_exclusions(owner_uid: str) -> list[tuple[str, str]]:
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT prompt, context_hash FROM cache_exclusions WHERE owner_uid = ?",
            (owner_uid,),
        )
        return [(row["prompt"], row["context_hash"]) for row in await cursor.fetchall()]
    finally:
        await db.close()


async def clear_cache_exclusion(owner_uid: str, prompt: str, context_hash: str) -> None:
    db = await get_connection()
    try:
        await db.execute(
            "DELETE FROM cache_exclusions WHERE owner_uid = ? AND prompt = ? AND context_hash = ?",
            (owner_uid, prompt, context_hash),
        )
        await db.commit()
    finally:
        await db.close()


async def get_cache_chat_origins(client_id: str) -> list[dict]:
    """Return the owner's chat turns for linking cache entries to their source."""
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT prompt, response, context_hash, chat_id, conversation_id, request_id "
            "FROM chat_history WHERE client_id = ? ORDER BY rowid ASC",
            (client_id,),
        )
        return [dict(row) for row in await cursor.fetchall()]
    finally:
        await db.close()


async def insert_cache_entry(
    cache_id: str, prompt_hash: str, cached_response: str,
    model_id: str | None = None, client_id: str | None = None,
    owner_uid: str | None = None, exact_hash: str | None = None,
    context_hash: str = "", request_id: str | None = None,
    selected_chat_id: str | None = None,
) -> bool:
    db = await get_connection()
    try:
        await db.execute(
            "INSERT OR IGNORE INTO semantic_cache "
            "(cache_id, prompt_hash, cached_response, model_id, client_id, owner_uid, exact_hash, context_hash, request_id, selected_chat_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (cache_id, prompt_hash, cached_response, model_id, client_id, owner_uid, exact_hash, context_hash, request_id, selected_chat_id),
        )
        inserted = db.total_changes > 0
        await db.commit()
        return inserted
    finally:
        await db.close()


async def increment_cache_hit(cache_id: str, match_type: str = "exact") -> None:
    db = await get_connection()
    try:
        await db.execute(
            "UPDATE semantic_cache SET hit_count = hit_count + 1, last_match_type = ? "
            "WHERE cache_id = ?",
            (match_type, cache_id),
        )
        await db.commit()
    finally:
        await db.close()


async def get_recent_audit_logs(limit: int = 50) -> list[dict]:
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT log_id, workflow_id, model_id, cache_id, status_code, "
            "latency_ms, total_cost, created_at "
            "FROM audit_logs ORDER BY created_at DESC LIMIT ?",
            (limit,),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def insert_audit_log(
    workflow_id: str | None,
    model_id: str,
    cache_id: str | None,
    status_code: int,
    latency_ms: float,
    total_cost: float,
    request_id: str | None = None,
) -> str:
    """Insert an audit log row and return the generated log_id."""
    log_id = f"log-{uuid.uuid4().hex[:8]}"
    db = await get_connection()
    try:
        await db.execute(
            "INSERT INTO audit_logs (log_id, workflow_id, model_id, cache_id, status_code, latency_ms, total_cost, request_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (log_id, workflow_id, model_id, cache_id, status_code, latency_ms, total_cost, request_id),
        )
        await db.commit()
    finally:
        await db.close()
    return log_id


async def insert_failed_model_request(
    client_id: str, model_id: str, tier: str, request_id: str | None
) -> None:
    db = await get_connection()
    try:
        await db.execute(
            "INSERT INTO failed_model_requests (event_id, client_id, model_id, tier, request_id) "
            "VALUES (?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), client_id, model_id, tier, request_id),
        )
        await db.commit()
    finally:
        await db.close()


async def update_workflow_spend(workflow_id: str, cost: float) -> None:
    """Add cost to a workflow's current_spend."""
    db = await get_connection()
    try:
        await db.execute(
            "UPDATE workflows SET current_spend = current_spend + ? WHERE workflow_id = ?",
            (cost, workflow_id),
        )
        await db.commit()
    finally:
        await db.close()


async def get_overview_stats(client_id: str) -> dict:
    """Aggregate stats for the OverviewPage dashboard."""
    db = await get_connection()
    try:
        # Total requests
        cursor = await db.execute(
            "SELECT COUNT(*) as cnt FROM audit_logs a JOIN workflows w ON a.workflow_id = w.workflow_id WHERE w.client_id = ?",
            (client_id,)
        )
        total_requests = (await cursor.fetchone())["cnt"]

        # Total cost
        cursor = await db.execute(
            "SELECT COALESCE(SUM(total_cost), 0) as total FROM audit_logs a JOIN workflows w ON a.workflow_id = w.workflow_id WHERE w.client_id = ?",
            (client_id,)
        )
        total_cost = (await cursor.fetchone())["total"]

        # Cache hits (audit_logs where cache_id is not null)
        cursor = await db.execute(
            "SELECT COUNT(*) as cnt FROM audit_logs a JOIN workflows w ON a.workflow_id = w.workflow_id WHERE a.cache_id IS NOT NULL AND w.client_id = ?",
            (client_id,)
        )
        cache_hits = (await cursor.fetchone())["cnt"]
        cache_hit_rate = (cache_hits / total_requests * 100) if total_requests > 0 else 0

        cursor = await db.execute(
            "SELECT "
            "COALESCE(SUM(CASE WHEN a.created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END), 0) AS last_24h, "
            "COALESCE(SUM(CASE WHEN a.created_at >= datetime('now', '-7 days') "
            "AND a.created_at < datetime('now', '-1 day') THEN 1 ELSE 0 END), 0) AS previous_6d "
            "FROM audit_logs a JOIN workflows w ON a.workflow_id = w.workflow_id WHERE w.client_id = ?",
            (client_id,),
        )
        recent = await cursor.fetchone()
        last_24h = recent["last_24h"]
        previous_6d = recent["previous_6d"]

        # Failover events (status_code >= 500)
        cursor = await db.execute(
            "SELECT COUNT(*) as cnt FROM audit_logs a JOIN workflows w ON a.workflow_id = w.workflow_id WHERE a.status_code >= 500 AND w.client_id = ?",
            (client_id,)
        )
        failover_count = (await cursor.fetchone())["cnt"]

        return {
            "total_requests": total_requests,
            "total_cost": round(total_cost, 4),
            "cache_hits": cache_hits,
            "generated_answers": total_requests - cache_hits,
            "cache_hit_rate": round(cache_hit_rate, 1),
            "request_recency": {
                "last_24h": last_24h,
                "previous_6d": previous_6d,
                "older": total_requests - last_24h - previous_6d,
            },
            "active_failovers": failover_count,
        }
    finally:
        await db.close()


async def get_requests_per_model(client_id: str) -> dict:
    """Hourly provider attempts for this user's connected models."""
    current_hour = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    first_hour = current_hour - timedelta(hours=23)
    hours = [first_hour + timedelta(hours=offset) for offset in range(24)]
    db = await get_connection()
    try:
        connections = await (await db.execute(
            "SELECT model_id, name, provider FROM model_connections "
            "WHERE client_id = ? ORDER BY created_at, rowid", (client_id,)
        )).fetchall()
        models = []
        seen = set()
        for connection in connections:
            model_id = connection["model_id"]
            if model_id not in seen:
                models.append({"id": model_id, "name": connection["name"], "provider": connection["provider"]})
                seen.add(model_id)

        start = first_hour.strftime('%Y-%m-%d %H:%M:%S')
        end = (current_hour + timedelta(hours=1)).strftime('%Y-%m-%d %H:%M:%S')
        counts = await (await db.execute(
            "SELECT model_id, strftime('%Y-%m-%dT%H:00:00Z', created_at) AS hour, "
            "COUNT(*) AS requests FROM ("
            "SELECT a.model_id, a.created_at FROM audit_logs a "
            "JOIN workflows w ON w.workflow_id = a.workflow_id "
            "WHERE w.client_id = ? AND a.cache_id IS NULL "
            "AND a.status_code BETWEEN 200 AND 299 AND a.model_id IS NOT NULL "
            "AND a.created_at >= ? AND a.created_at < ? "
            "UNION ALL "
            "SELECT f.model_id, f.created_at FROM failed_model_requests f "
            "WHERE f.client_id = ? AND f.created_at >= ? AND f.created_at < ?"
            ") GROUP BY model_id, hour",
            (client_id, start, end, client_id, start, end),
        )).fetchall()
        by_hour = {(row["hour"], row["model_id"]): row["requests"] for row in counts}
        return {
            "models": models,
            "hours": [
                {"time": hour.strftime('%Y-%m-%dT%H:00:00Z'),
                 "counts": {model["id"]: by_hour.get((hour.strftime('%Y-%m-%dT%H:00:00Z'), model["id"]), 0)
                            for model in models}}
                for hour in hours
            ],
        }
    finally:
        await db.close()


async def get_weekly_model_requests(client_id: str, timezone_offset_minutes: int = 0) -> dict:
    """Count this month's model calls by seven-day week and connected tier."""
    offset = timedelta(minutes=max(-720, min(840, timezone_offset_minutes)))
    local_now = datetime.now(timezone.utc) + offset
    year, month = local_now.year, local_now.month
    days_in_month = calendar.monthrange(year, month)[1]
    next_year, next_month = (year + 1, 1) if month == 12 else (year, month + 1)
    start_utc = datetime(year, month, 1, tzinfo=timezone.utc) - offset
    end_utc = datetime(next_year, next_month, 1, tzinfo=timezone.utc) - offset
    start, end = (value.strftime('%Y-%m-%d %H:%M:%S') for value in (start_utc, end_utc))

    db = await get_connection()
    try:
        connections = await (await db.execute(
            "SELECT model_id, name, provider, tier FROM model_connections "
            "WHERE client_id = ? ORDER BY created_at, rowid", (client_id,)
        )).fetchall()
        models = []
        model_keys = set()
        tiers_by_model = {}
        for connection in connections:
            tier, model_id = connection["tier"], connection["model_id"]
            key = f"{tier}|{model_id}"
            tiers_by_model.setdefault(model_id, set()).add(tier)
            if key not in model_keys:
                models.append({"key": key, "id": model_id, "name": connection["name"],
                               "provider": connection["provider"], "tier": tier})
                model_keys.add(key)

        weeks = [
            {"week": f"Week {index + 1}", "counts": {model["key"]: 0 for model in models}}
            for index in range((days_in_month + 6) // 7)
        ]
        completed = await (await db.execute(
            "SELECT a.model_id, a.created_at, w.workflow_id FROM audit_logs a "
            "JOIN workflows w ON w.workflow_id = a.workflow_id "
            "WHERE w.client_id = ? AND a.cache_id IS NULL "
            "AND a.status_code BETWEEN 200 AND 299 AND a.model_id IS NOT NULL "
            "AND a.created_at >= ? AND a.created_at < ?",
            (client_id, start, end),
        )).fetchall()
        failed = await (await db.execute(
            "SELECT model_id, created_at, tier FROM failed_model_requests "
            "WHERE client_id = ? AND created_at >= ? AND created_at < ?",
            (client_id, start, end),
        )).fetchall()

        def count_request(model_id: str, created_at: str, tier: str | None) -> None:
            if tier is None:
                matching_tiers = tiers_by_model.get(model_id, set())
                tier = next(iter(matching_tiers)) if len(matching_tiers) == 1 else None
            key = f"{tier}|{model_id}"
            if key not in model_keys:
                return
            created_utc = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
            if created_utc.tzinfo is None:
                created_utc = created_utc.replace(tzinfo=timezone.utc)
            local_date = (created_utc + offset).date()
            if local_date.year == year and local_date.month == month:
                weeks[(local_date.day - 1) // 7]["counts"][key] += 1

        for row in completed:
            workflow_id = row["workflow_id"] or ""
            tier = next((name for name in ("light", "mid", "heavy")
                         if workflow_id.endswith(f"-{name}")), None)
            count_request(row["model_id"], row["created_at"], tier)
        for row in failed:
            count_request(row["model_id"], row["created_at"], row["tier"])

        return {"month": local_now.strftime('%B %Y'), "models": models, "weeks": weeks}
    finally:
        await db.close()


async def get_budget_summary(client_id: str) -> list[dict]:
    """Return budget data for the BudgetPage."""
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT w.workflow_id, w.workflow_name, w.current_spend, "
            "COALESCE(SUM(rp.max_token_budget), 0) as total_budget "
            "FROM workflows w "
            "LEFT JOIN routing_policies rp ON w.workflow_id = rp.workflow_id "
            "WHERE w.client_id = ? "
            "GROUP BY w.workflow_id",
            (client_id,)
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()

async def get_user_by_firebase_uid(firebase_uid: str) -> dict | None:
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT client_id, email, firebase_uid, organization_name FROM users WHERE firebase_uid = ?",
            (firebase_uid,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()

async def get_unclaimed_placeholder_user() -> dict | None:
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT client_id, email, firebase_uid, organization_name FROM users WHERE firebase_uid IS NULL LIMIT 1"
        )
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()

async def claim_user(client_id: str, firebase_uid: str, email: str) -> None:
    db = await get_connection()
    try:
        await db.execute(
            "UPDATE users SET firebase_uid = ?, email = ? WHERE client_id = ?",
            (firebase_uid, email, client_id)
        )
        await db.commit()
    finally:
        await db.close()

async def create_user(client_id: str, email: str, firebase_uid: str, organization_name: str) -> None:
    db = await get_connection()
    try:
        await db.execute(
            "INSERT INTO users (client_id, email, firebase_uid, organization_name, api_key_hash) VALUES (?, ?, ?, ?, ?)",
            (client_id, email, firebase_uid, organization_name, "")
        )
        await db.commit()
    finally:
        await db.close()

async def create_workflow(workflow_id: str, client_id: str, workflow_name: str) -> None:
    db = await get_connection()
    try:
        await db.execute(
            "INSERT INTO workflows (workflow_id, client_id, workflow_name, current_spend) VALUES (?, ?, ?, 0.0)",
            (workflow_id, client_id, workflow_name)
        )
        await db.commit()
    finally:
        await db.close()


async def ensure_tier_workflow(client_id: str, tier: str) -> str:
    """Keep spend and audit rows inside the signed-in user's selected tier."""
    names = {
        "light": "Workflow A: Document Processing",
        "mid": "Workflow B: General Assistant",
        "heavy": "Workflow C: Specialized Analysis",
    }
    workflow_id = f"tier-{client_id}-{tier}"
    connection = await get_connection()
    try:
        await connection.execute(
            "INSERT OR IGNORE INTO workflows (workflow_id, client_id, workflow_name, current_spend) "
            "VALUES (?, ?, ?, 0)",
            (workflow_id, client_id, names[tier]),
        )
        await connection.commit()
    finally:
        await connection.close()
    return workflow_id



# ---------------------------------------------------------------------------
# Chat History CRUD
# ---------------------------------------------------------------------------

async def save_chat(chat_id: str, client_id: str, title: str, prompt: str,
                    response_json: str, model_used: str, tier_used: str,
                    cost_usd: float, latency_ms: float,
                    conversation_id: str | None = None, turn_index: int = 0,
                    context_hash: str = "", request_id: str | None = None) -> None:
    """Insert a new chat history entry."""
    db = await get_connection()
    try:
        await db.execute(
            "INSERT INTO chat_history (chat_id, client_id, title, prompt, response, model_used, tier_used, "
            "cost_usd, latency_ms, conversation_id, turn_index, context_hash, request_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (chat_id, client_id, title, prompt, response_json, model_used, tier_used,
             cost_usd, latency_ms, conversation_id or chat_id, turn_index, context_hash, request_id)
        )
        await db.commit()
    finally:
        await db.close()


async def discard_cancelled_request(client_id: str, owner_uid: str, request_id: str) -> None:
    """Remove only the chat and cache rows written by this request."""
    db = await get_connection()
    try:
        await db.execute(
            "UPDATE workflows SET current_spend = MAX(0, current_spend - COALESCE(("
            "SELECT SUM(total_cost) FROM audit_logs WHERE audit_logs.workflow_id = workflows.workflow_id "
            "AND audit_logs.request_id = ?), 0)) WHERE client_id = ?",
            (request_id, client_id),
        )
        await db.execute("DELETE FROM audit_logs WHERE request_id = ?", (request_id,))
        await db.execute(
            "DELETE FROM failed_model_requests WHERE client_id = ? AND request_id = ?",
            (client_id, request_id),
        )
        await db.execute(
            "UPDATE audit_logs SET cache_id = NULL WHERE cache_id IN "
            "(SELECT cache_id FROM semantic_cache WHERE owner_uid = ? AND request_id = ?)",
            (owner_uid, request_id),
        )
        await db.execute(
            "DELETE FROM chat_history WHERE client_id = ? AND request_id = ?",
            (client_id, request_id),
        )
        await db.execute(
            "DELETE FROM semantic_cache WHERE owner_uid = ? AND request_id = ?",
            (owner_uid, request_id),
        )
        await db.commit()
    finally:
        await db.close()


async def get_chat_history(client_id: str, limit: int = 50) -> list[dict]:
    """Return the most recent chats for a user, newest first."""
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT chat_id, title, prompt, created_at FROM chat_history "
            "WHERE client_id = ? ORDER BY created_at DESC LIMIT ?",
            (client_id, limit)
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


async def get_chat_by_id(chat_id: str, client_id: str) -> dict | None:
    """Return a single chat (with full response) scoped to the owner."""
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT chat_id, title, prompt, response, model_used, tier_used, cost_usd, latency_ms, created_at "
            "FROM chat_history WHERE chat_id = ? AND client_id = ?",
            (chat_id, client_id)
        )
        row = await cursor.fetchone()
        return dict(row) if row else None
    finally:
        await db.close()


async def get_conversation_turns(conversation_id: str, client_id: str) -> list[dict]:
    """Load a conversation in turn order, scoped to its authenticated owner."""
    db = await get_connection()
    try:
        cursor = await db.execute(
            "SELECT chat_id, conversation_id, title, prompt, response, model_used, "
            "tier_used, cost_usd, latency_ms, created_at, turn_index, context_hash "
            "FROM chat_history WHERE conversation_id = ? AND client_id = ? "
            "ORDER BY turn_index, rowid",
            (conversation_id, client_id),
        )
        return [dict(row) for row in await cursor.fetchall()]
    finally:
        await db.close()


async def get_conversations(client_id: str, limit: int = 50, query: str = "") -> list[dict]:
    """List a user's conversations, optionally searching every turn."""
    db = await get_connection()
    try:
        query = query.strip()
        match_clause = (
            "instr(lower(hit.title), lower(?)) > 0 OR "
            "instr(lower(hit.prompt), lower(?)) > 0 OR "
            "instr(lower(hit.response), lower(?)) > 0"
        )
        search_filter = (
            "AND EXISTS (SELECT 1 FROM chat_history hit "
            "WHERE hit.client_id = first.client_id "
            "AND hit.conversation_id = first.conversation_id "
            f"AND ({match_clause})) "
        ) if query else ""
        matching_turn = (
            "(SELECT hit.chat_id FROM chat_history hit "
            "WHERE hit.client_id = first.client_id "
            "AND hit.conversation_id = first.conversation_id "
            f"AND ({match_clause}) "
            "ORDER BY hit.turn_index, hit.rowid LIMIT 1) AS matching_turn_id, "
        ) if query else "NULL AS matching_turn_id, "
        matching_prompt = (
            "(SELECT substr(hit.prompt, 1, 160) FROM chat_history hit "
            "WHERE hit.client_id = first.client_id "
            "AND hit.conversation_id = first.conversation_id "
            f"AND ({match_clause}) "
            "ORDER BY hit.turn_index, hit.rowid LIMIT 1) AS matching_prompt, "
        ) if query else "NULL AS matching_prompt, "
        params = ([query] * 6 if query else []) + [client_id]
        if query:
            params.extend([query] * 3)
        params.append(limit)
        cursor = await db.execute(
            "SELECT first.conversation_id AS chat_id, first.title, "
            + matching_turn + matching_prompt +
            "MAX(turn.rowid) AS latest_rowid, MAX(turn.created_at) AS created_at, "
            "COUNT(turn.chat_id) AS turn_count "
            "FROM chat_history first JOIN chat_history turn "
            "ON turn.conversation_id = first.conversation_id "
            "AND turn.client_id = first.client_id "
            "WHERE first.client_id = ? AND first.turn_index = 0 "
            + search_filter +
            "GROUP BY first.conversation_id ORDER BY latest_rowid DESC LIMIT ?",
            params,
        )
        return [dict(row) for row in await cursor.fetchall()]
    finally:
        await db.close()
