import asyncio
import hashlib
import json
import logging
import math
import re
import unicodedata
import uuid
import weakref
from pathlib import Path
from typing import Optional

from optiroute.models import ChatCompletionRequest, ChatCompletionResponse
from optiroute import database as db
from optiroute.engine.workload import clearly_incomplete_code_answer, is_complete_code_request

logger = logging.getLogger("optiroute")


class _EmbeddingModel:
    """Run the existing MiniLM model through ONNX instead of PyTorch."""

    def __init__(self):
        from fastembed import TextEmbedding

        self._model = TextEmbedding(
            model_name="sentence-transformers/all-MiniLM-L6-v2",
            threads=1,
            cache_dir=str(Path(__file__).resolve().parents[2] / ".model_cache"),
        )

    def encode(self, text: str, convert_to_tensor: bool = False):
        # Return a NumPy vector for compatibility with existing stored vectors.
        return next(self._model.embed([text]))


def _cosine_similarity(left, right) -> float:
    numerator = math.fsum(float(a) * float(b) for a, b in zip(left, right))
    left_norm = math.sqrt(math.fsum(float(value) ** 2 for value in left))
    right_norm = math.sqrt(math.fsum(float(value) ** 2 for value in right))
    return numerator / (left_norm * right_norm) if left_norm and right_norm else 0.0


class CacheManager:
    """Per-user exact and semantic prompt cache."""

    _request_locks = weakref.WeakValueDictionary()

    def request_lock(self, request: ChatCompletionRequest, owner_uid: str) -> asyncio.Lock:
        """Serialize identical in-flight requests until the first answer is cached."""
        key = (owner_uid, self._cache_scope(request), self._exact_hash(self._extract_prompt(request)))
        lock = self._request_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._request_locks[key] = lock
        return lock

    @staticmethod
    def _reusable(response: ChatCompletionResponse) -> bool:
        return (
            not response.id.startswith("mock_")
            and bool(response.choices)
            and all(choice.finish_reason != "length" for choice in response.choices)
            and any(choice.message.content or choice.message.tool_calls for choice in response.choices)
        )

    @classmethod
    def _acceptable_cached_answer(cls, prompt: str, response: ChatCompletionResponse, pinned: bool = False) -> bool:
        if not cls._reusable(response):
            return False
        content = response.choices[0].message.content or ""
        # An explicit user cache choice takes precedence over the heuristic.
        return pinned or not clearly_incomplete_code_answer(prompt, content)

    _model = None
    # Lower thresholds operate on framing-stripped prompt text. The overlap
    # guard and intent check keep broad recall from reusing unrelated answers.
    SEMANTIC_THRESHOLD = 0.76
    HIGH_CONFIDENCE_THRESHOLD = 0.82
    REQUEST_PREFIXES = (
        r"^(?:please\s+)?(?:can|could|would)\s+you\s+",
        r"^(?:please\s+)?(?:tell me about|give me (?:information|info|details) about|provide (?:information|details) about|give an overview of|provide an overview of|what is|what are|what's|who is|who are|explain|describe|define)\s+",
    )
    AUXILIARIES = {"am", "is", "are", "was", "were", "do", "does", "did", "be", "been", "being"}
    NEGATIONS = {"not", "never", "no", "without", "cannot", "dont", "wont", "isnt", "arent"}
    CONTENT_STOPWORDS = {
        "a", "an", "the", "please", "can", "could", "would", "you", "me",
        "tell", "about", "give", "information", "info", "details", "provide",
        "overview", "what", "is", "are", "who", "explain", "describe", "define",
        "how", "does", "do", "of", "to", "for", "and", "or", "in", "on", "with",
        "please", "used", "use", "it", "its",
    }

    @classmethod
    def get_model(cls):
        if cls._model is None:
            cls._model = _EmbeddingModel()
        return cls._model

    def _extract_prompt(self, request: ChatCompletionRequest) -> str:
        return next(
            (msg.content for msg in reversed(request.messages)
             if msg.role == "user" and msg.content),
            "",
        )

    def _context_hash(self, request: ChatCompletionRequest) -> str:
        """Keep follow-up answers separate when their prior turns differ."""
        prior_messages = request.messages[:-1]
        if not prior_messages:
            return ""
        context = [
            {"role": msg.role, "content": msg.content or ""}
            for msg in prior_messages
        ]
        payload = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _needs_prior_context(self, prompt: str, has_prior_turn: bool) -> bool:
        """Only referential follow-ups need a conversation-specific cache key."""
        if not has_prior_turn:
            return False
        text = self._strict_prompt(prompt)
        if re.search(r"\b(?:previous (?:answer|response|message|story)|above|earlier|same (?:answer|story|code)|continue|carry on)\b", text):
            return True
        if len(text.split()) <= 40 and re.search(
            r"^(?:and\b|also\b|what about\b|make (?:it|this|that)\b|change (?:it|this|that)\b|rewrite (?:it|this|that)\b|expand (?:it|this|that|on that)\b|shorten (?:it|this|that)\b|explain (?:it|this|that)\b)|\b(?:it|that|those|them|this one)\b",
            text,
        ):
            return True
        return False

    def _cache_scope(self, request: ChatCompletionRequest) -> str:
        has_prior_turn = any(m.role in ("user", "assistant") for m in request.messages[:-1])
        prompt = self._extract_prompt(request)
        return self._context_hash(request) if self._needs_prior_context(prompt, has_prior_turn) else ""

    def _candidate_allowed(self, candidate_prompt: str, candidate_context: str, scope: str) -> bool:
        if scope:
            return candidate_context == scope
        return not self._needs_prior_context(candidate_prompt, bool(candidate_context))

    def _strict_prompt(self, prompt: str) -> str:
        normalized = unicodedata.normalize("NFKC", prompt).casefold().strip()
        # Copying a prompt from a document often wraps the whole request in
        # quotes. Those wrappers do not change the task or its constraints.
        quote_pairs = {'"': '"', "'": "'", "“": "”", "‘": "’"}
        while len(normalized) >= 2:
            candidate = normalized.rstrip(" .!?")
            if len(candidate) < 2 or quote_pairs.get(candidate[0]) != candidate[-1]:
                break
            normalized = candidate[1:-1].strip()
        return re.sub(r"\s+", " ", normalized).strip()

    def _meaning_prompt(self, prompt: str) -> str:
        # Remove common question framing so “what is X” and “tell me about X”
        # use the same cache key while retaining the subject and task details.
        normalized = self._strict_prompt(prompt).strip(" ?!.,;:")
        for _ in range(3):
            previous = normalized
            for prefix in self.REQUEST_PREFIXES:
                stripped = re.sub(prefix, "", normalized, count=1)
                if stripped != normalized:
                    normalized = stripped.strip(" ?!.,;:")
                    break
            if normalized == previous:
                break
        normalized = re.sub(r"\b(?:a|an|the)\b", " ", normalized)
        return re.sub(r"\s+", " ", normalized).strip()

    def _critical_signature(self, prompt: str) -> tuple:
        """Keep changes to quantities, negation and quoted literals from reusing answers."""
        normalized = self._strict_prompt(prompt)
        words = set(re.findall(r"[a-z]+", normalized.replace("n't", " not")))
        numbers = tuple(re.findall(r"\b\d+(?:\.\d+)?\b", normalized))
        quoted = tuple(re.findall(r'"([^"]+)"|`([^`]+)`|(?<!\w)\'([^\']{2,})\'', normalized))
        return numbers, bool(words & self.NEGATIONS), quoted

    def _comparison_tokens(self, prompt: str) -> list[str]:
        normalized = self._meaning_prompt(prompt)
        normalized = re.sub(r"([a-z])\1{2,}", r"\1\1", normalized)
        return [
            word for word in re.findall(r"[a-z0-9]+", normalized)
            if word not in self.AUXILIARIES
        ]

    @staticmethod
    def _grammar_forms(word: str) -> set[str]:
        forms = {word}
        if len(word) >= 5 and word.endswith("ies"):
            forms.add(word[:-3] + "y")
        if len(word) >= 5 and word.endswith("s"):
            forms.add(word[:-1])
        if len(word) >= 5 and word.endswith("es"):
            forms.add(word[:-2])
        if len(word) >= 6 and word.endswith("ing"):
            base = word[:-3]
            forms.update((base, base + "e"))
            if len(base) > 2 and base[-1] == base[-2]:
                forms.add(base[:-1])
        if len(word) >= 5 and word.endswith("ed"):
            base = word[:-2]
            forms.update((base, word[:-1]))
            if len(base) > 2 and base[-1] == base[-2]:
                forms.add(base[:-1])
        return forms

    @staticmethod
    def _adjacent_swap(left: str, right: str) -> bool:
        differences = [i for i, (a, b) in enumerate(zip(left, right)) if a != b]
        return (
            len(left) == len(right)
            and len(differences) == 2
            and differences[1] == differences[0] + 1
            and left[differences[0]] == right[differences[1]]
            and left[differences[1]] == right[differences[0]]
        )

    @staticmethod
    def _one_typo_apart(left: str, right: str) -> bool:
        """Allow one insertion, deletion, substitution or adjacent swap."""
        if left == right:
            return True
        if abs(len(left) - len(right)) > 1:
            return False
        if len(left) == len(right):
            differences = [i for i, (a, b) in enumerate(zip(left, right)) if a != b]
            return len(differences) == 1 or CacheManager._adjacent_swap(left, right)
        shorter, longer = sorted((left, right), key=len)
        for index in range(len(longer)):
            if longer[:index] + longer[index + 1:] == shorter:
                return True
        return False

    def _surface_match_score(self, query: str, candidate: str) -> float:
        """Match spelling and inflection changes before loading embeddings."""
        if self._critical_signature(query) != self._critical_signature(candidate):
            return 0.0
        query_words = self._comparison_tokens(query)
        candidate_words = self._comparison_tokens(candidate)
        if not query_words or len(query_words) != len(candidate_words):
            return 0.0
        typo_count = 0
        for left, right in zip(query_words, candidate_words):
            if self._grammar_forms(left) & self._grammar_forms(right):
                continue
            # Very short words and numbers can change the task when edited.
            short_swap = (
                len(query_words) == 1 and min(len(left), len(right)) >= 5
                and self._adjacent_swap(left, right)
            )
            if min(len(left), len(right)) < (7 if len(query_words) == 1 else 5) and not short_swap:
                return 0.0
            if not self._one_typo_apart(left, right):
                return 0.0
            typo_count += 1
        if typo_count > max(1, len(query_words) // 2):
            return 0.0
        return 1.0 - 0.05 * typo_count

    def _has_semantic_overlap(self, query: str, candidate: str) -> bool:
        query_terms = {
            term for term in re.findall(r"[a-z0-9]+", self._meaning_prompt(query))
            if term not in self.CONTENT_STOPWORDS and len(term) > 1
        }
        candidate_terms = {
            term for term in re.findall(r"[a-z0-9]+", self._meaning_prompt(candidate))
            if term not in self.CONTENT_STOPWORDS and len(term) > 1
        }
        if not query_terms or not candidate_terms:
            return False
        overlap = len(query_terms & candidate_terms) / min(len(query_terms), len(candidate_terms))
        return overlap >= 0.34

    def _request_intent(self, prompt: str) -> str:
        normalized = self._strict_prompt(prompt)
        if re.search(r"\b(compare|comparison|difference|differences|versus|vs)\b", normalized):
            return "comparison"
        if re.search(r"\b(list|enumerate|name|examples?)\b", normalized):
            return "list"
        if re.search(r"\b(how to|steps to|instructions|procedure)\b", normalized):
            return "procedure"
        return "explanation"

    def _is_semantic_match(self, score: float, query: str, candidate: str) -> bool:
        # Compare the user's task before semantic similarity. For ordinary
        # matches require some shared subject vocabulary; high similarity can
        # cover paraphrases whose wording differs substantially.
        if self._critical_signature(query) != self._critical_signature(candidate):
            return False
        if self._request_intent(query) != self._request_intent(candidate):
            return False
        return score >= self.HIGH_CONFIDENCE_THRESHOLD or (
            score >= self.SEMANTIC_THRESHOLD and self._has_semantic_overlap(query, candidate)
        )

    def _exact_hash(self, prompt: str) -> str:
        canonical = self._meaning_prompt(prompt)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    async def _get_user_history(self, client_id: str, scope: str):
        conn = await db.get_connection()
        try:
            sql = "SELECT chat_id, prompt, response, context_hash FROM chat_history WHERE client_id = ?"
            params = [client_id]
            if scope:
                sql += " AND context_hash = ?"
                params.append(scope)
            sql += " ORDER BY rowid DESC LIMIT 500"
            async with conn.execute(sql, params) as cursor:
                rows = await cursor.fetchall()
            superseded_ids = set()
            for row in rows:
                try:
                    replaced_id = json.loads(row[2]).get("optiroute", {}).get("retry_from_chat_id")
                except (TypeError, ValueError, AttributeError):
                    replaced_id = None
                if replaced_id:
                    superseded_ids.add(replaced_id)
            return [(row[1], row[2], row[3]) for row in rows if row[0] not in superseded_ids]
        finally:
            await conn.close()

    async def check_cache(
        self, request: ChatCompletionRequest, client_id: str, owner_uid: str,
        request_id: str | None = None,
    ) -> Optional[tuple[ChatCompletionResponse, str, str]]:
        """Find a canonical question match, then a guarded semantic match."""
        prompt = self._extract_prompt(request)
        if not prompt:
            return None

        prompt_hash = self._exact_hash(prompt)
        context_hash = self._cache_scope(request)
        exclusions = await db.get_cache_exclusions(owner_uid)
        excluded_prompts = {
            self._strict_prompt(old_prompt)
            for old_prompt, old_context in exclusions if old_context == context_hash
        }
        if self._strict_prompt(prompt) in excluded_prompts:
            return None
        conn = await db.get_connection()
        try:
            sql = "SELECT cache_id, prompt_hash, cached_response, context_hash, selection_pinned FROM semantic_cache WHERE owner_uid = ?"
            params = [owner_uid]
            if context_hash:
                sql += " AND context_hash = ?"
                params.append(context_hash)
            async with conn.execute(
                sql, params,
            ) as cursor:
                cache_rows = await cursor.fetchall()
        finally:
            await conn.close()

        # Exact text wins even for rows saved under an older normalization rule.
        # Self-contained prompts may use an entry created in another chat.
        for mode in ("exact", "normalized"):
            for cache_id, prompt_hash_json, cached_response, stored_context, pinned in cache_rows:
                try:
                    metadata = json.loads(prompt_hash_json)
                except (json.JSONDecodeError, TypeError):
                    metadata = {}
                stored_prompt = metadata.get("prompt", "")
                if not stored_prompt or not self._candidate_allowed(stored_prompt, stored_context, context_hash):
                    continue
                strict_match = self._strict_prompt(stored_prompt) == self._strict_prompt(prompt)
                if mode == "exact" and not strict_match:
                    continue
                if mode == "normalized":
                    if strict_match:
                        continue
                    canonical_match = metadata.get("hash") == prompt_hash or self._exact_hash(stored_prompt) == prompt_hash
                    if not canonical_match or self._critical_signature(stored_prompt) != self._critical_signature(prompt):
                        continue
                try:
                    response = ChatCompletionResponse.model_validate_json(cached_response)
                except (TypeError, ValueError):
                    continue
                if not self._acceptable_cached_answer(prompt, response, bool(pinned)):
                    continue
                match_type = "exact" if strict_match else "semantic"
                await db.increment_cache_hit(cache_id, match_type)
                logger.info("Cache hit for %s (%s)", cache_id, match_type)
                return response, match_type, cache_id

        history_rows = [
            row for row in await self._get_user_history(client_id, context_hash)
            if self._strict_prompt(row[0]) not in excluded_prompts
        ]
        if not cache_rows and not history_rows:
            return None

        # Chat history is user-scoped. It safely backfills older conversations
        # whose cache rows were written before cache ownership was added.
        for mode in ("exact", "normalized"):
            for old_prompt, old_response, old_context in history_rows:
                if not self._candidate_allowed(old_prompt, old_context, context_hash):
                    continue
                strict_match = self._strict_prompt(old_prompt) == self._strict_prompt(prompt)
                if mode == "exact" and not strict_match:
                    continue
                if mode == "normalized" and (strict_match or self._exact_hash(old_prompt) != prompt_hash or
                                             self._critical_signature(old_prompt) != self._critical_signature(prompt)):
                    continue
                try:
                    response = ChatCompletionResponse.model_validate_json(old_response)
                except (ValueError, TypeError):
                    continue
                if not self._acceptable_cached_answer(prompt, response):
                    continue
                cache_id = await self._store_prompt_cache(
                    old_prompt, response, client_id, owner_uid, context_hash, request_id
                )
                match_type = "exact" if strict_match else "semantic"
                await db.increment_cache_hit(cache_id, match_type)
                return response, match_type, cache_id

        # Spelling and grammatical variants are cheaper and often more reliable
        # to compare directly than embeddings of misspelled text.
        best_surface_cache = None
        for cache_id, prompt_hash_json, cached_response, stored_context, pinned in cache_rows:
            try:
                stored_prompt = json.loads(prompt_hash_json).get("prompt", "")
                if not stored_prompt or not self._candidate_allowed(stored_prompt, stored_context, context_hash):
                    continue
                score = self._surface_match_score(prompt, stored_prompt)
                response = ChatCompletionResponse.model_validate_json(cached_response)
            except (AttributeError, TypeError, ValueError):
                continue
            if score and self._acceptable_cached_answer(prompt, response, bool(pinned)) and (
                best_surface_cache is None or score > best_surface_cache[0]
            ):
                best_surface_cache = (score, cache_id, response)

        best_surface_history = None
        for old_prompt, old_response, old_context in history_rows:
            if not self._candidate_allowed(old_prompt, old_context, context_hash):
                continue
            score = self._surface_match_score(prompt, old_prompt)
            if not score:
                continue
            try:
                response = ChatCompletionResponse.model_validate_json(old_response)
            except (TypeError, ValueError):
                continue
            if self._acceptable_cached_answer(prompt, response) and (
                best_surface_history is None or score > best_surface_history[0]
            ):
                best_surface_history = (score, old_prompt, response)

        if best_surface_cache and (
            not best_surface_history or best_surface_cache[0] >= best_surface_history[0]
        ):
            _, cache_id, response = best_surface_cache
            await db.increment_cache_hit(cache_id, "semantic")
            logger.info("Spelling/grammar cache hit for %s", cache_id)
            return response, "semantic", cache_id

        if best_surface_history:
            _, old_prompt, response = best_surface_history
            cache_id = await self._store_prompt_cache(
                old_prompt, response, client_id, owner_uid, context_hash, request_id
            )
            await db.increment_cache_hit(cache_id, "semantic")
            return response, "semantic", cache_id

        model = self.get_model()
        query_meaning = self._meaning_prompt(prompt)
        query_embedding = model.encode(query_meaning, convert_to_tensor=True)
        best_cache = None
        best_history = None

        for cache_id, prompt_hash_json, cached_response, stored_context, pinned in cache_rows:
            try:
                metadata = json.loads(prompt_hash_json)
                stored_prompt = metadata.get("prompt")
                if not stored_prompt or not self._candidate_allowed(stored_prompt, stored_context, context_hash):
                    continue
                embedding = metadata.get("meaning_embedding")
                if stored_prompt:
                    response = ChatCompletionResponse.model_validate_json(cached_response)
                    if not self._acceptable_cached_answer(prompt, response, bool(pinned)):
                        continue
                    # Old cache rows stored vectors for the full sentence.
                    # Re-encode their normalized meaning once when encountered.
                    if not embedding or metadata.get("embedding_backend") != "fastembed-minilm-v1":
                        embedding = model.encode(
                            self._meaning_prompt(stored_prompt)
                        ).tolist()
                    score = _cosine_similarity(query_embedding, embedding)
                    if self._is_semantic_match(score, prompt, stored_prompt) and (
                        best_cache is None or score > best_cache[0]
                    ):
                        best_cache = (score, cache_id, response, stored_prompt)
            except (json.JSONDecodeError, TypeError, ValueError):
                continue

        for old_prompt, old_response, old_context in history_rows:
            if not self._candidate_allowed(old_prompt, old_context, context_hash):
                continue
            try:
                response = ChatCompletionResponse.model_validate_json(old_response)
                if not self._acceptable_cached_answer(prompt, response):
                    continue
                old_embedding = model.encode(
                    self._meaning_prompt(old_prompt), convert_to_tensor=True
                )
                score = _cosine_similarity(query_embedding, old_embedding)
                if self._is_semantic_match(score, prompt, old_prompt) and (
                    best_history is None or score > best_history[0]
                ):
                    best_history = (score, old_prompt, response)
            except (TypeError, ValueError):
                continue

        if best_cache:
            _, cache_id, response, _ = best_cache
            await db.increment_cache_hit(cache_id, "semantic")
            logger.info("Semantic cache hit for %s (score %.3f)", cache_id, best_cache[0])
            return response, "semantic", cache_id

        if best_history:
            _, old_prompt, response = best_history
            cache_id = await self._store_prompt_cache(
                old_prompt, response, client_id, owner_uid, context_hash, request_id
            )
            await db.increment_cache_hit(cache_id, "semantic")
            logger.info("Semantic chat-history hit for %s (score %.3f)", cache_id, best_history[0])
            return response, "semantic", cache_id

        return None

    async def _store_prompt_cache(
        self, prompt: str, response: ChatCompletionResponse, client_id: str,
        owner_uid: str, context_hash: str, request_id: str | None = None,
        replace_existing: bool = False,
        selected_chat_id: str | None = None, pin_selection: bool = False,
    ) -> str:
        prompt_hash = self._exact_hash(prompt)
        cache_id = f"cache-{uuid.uuid4().hex[:8]}"
        model = self.get_model()
        meaning_prompt = self._meaning_prompt(prompt)
        metadata = {
            "hash": prompt_hash,
            "normalized_hash": prompt_hash,
            "prompt": prompt,
            "context_hash": context_hash,
            # Keep a meaning-focused vector so wrappers like “what is” and
            # “tell me about” do not dominate the semantic comparison.
            "meaning_embedding": model.encode(meaning_prompt).tolist(),
            "embedding_backend": "fastembed-minilm-v1",
        }
        if replace_existing:
            # Replace the old answer as a new cache row only after a complete
            # heavier answer exists. Keep deletion and insertion atomic.
            conn = await db.get_connection()
            try:
                await conn.execute("BEGIN IMMEDIATE")
                async with conn.execute(
                    "SELECT cache_id, prompt_hash, exact_hash, selection_pinned FROM semantic_cache "
                    "WHERE owner_uid = ? AND context_hash = ?",
                    (owner_uid, context_hash),
                ) as cursor:
                    existing = await cursor.fetchall()
                matching = []
                for row in existing:
                    try:
                        old_prompt = json.loads(row[1]).get("prompt", "")
                    except (TypeError, ValueError):
                        old_prompt = ""
                    if row[2] != prompt_hash and self._strict_prompt(old_prompt) != self._strict_prompt(prompt):
                        continue
                    matching.append(row)
                if not pin_selection and any(row[3] for row in matching):
                    await conn.rollback()
                    return next(row[0] for row in matching if row[3])
                for row in matching:
                    await conn.execute("UPDATE audit_logs SET cache_id = NULL WHERE cache_id = ?", (row[0],))
                    await conn.execute("DELETE FROM semantic_cache WHERE owner_uid = ? AND cache_id = ?", (owner_uid, row[0]))
                await conn.execute(
                    "INSERT INTO semantic_cache "
                    "(cache_id, prompt_hash, cached_response, model_id, client_id, owner_uid, exact_hash, context_hash, request_id, selected_chat_id, selection_pinned) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (cache_id, json.dumps(metadata), response.model_dump_json(exclude_none=True), response.model,
                     client_id, owner_uid, prompt_hash, context_hash, request_id, selected_chat_id, int(pin_selection)),
                )
                await conn.commit()
            except Exception:
                await conn.rollback()
                raise
            finally:
                await conn.close()
            return cache_id
        inserted = await db.insert_cache_entry(
            cache_id=cache_id,
            prompt_hash=json.dumps(metadata),
            cached_response=response.model_dump_json(exclude_none=True),
            model_id=response.model,
            client_id=client_id,
            owner_uid=owner_uid,
            exact_hash=prompt_hash,
            context_hash=context_hash,
            request_id=request_id,
            selected_chat_id=selected_chat_id,
        )
        if not inserted:
            conn = await db.get_connection()
            try:
                async with conn.execute(
                    "SELECT cache_id, cached_response FROM semantic_cache "
                    "WHERE owner_uid = ? AND context_hash = ? AND exact_hash = ? LIMIT 1",
                    (owner_uid, context_hash, prompt_hash),
                ) as cursor:
                    row = await cursor.fetchone()
                    if row:
                        cache_id = row[0]
                        try:
                            old_response = ChatCompletionResponse.model_validate_json(row[1])
                        except (TypeError, ValueError):
                            old_response = None
                        if old_response is None or not self._reusable(old_response):
                            await conn.execute(
                                "UPDATE semantic_cache SET cached_response = ?, model_id = ?, prompt_hash = ?, request_id = ? "
                                "WHERE cache_id = ?",
                                (response.model_dump_json(exclude_none=True), response.model,
                                 json.dumps(metadata), request_id, cache_id),
                            )
                            await conn.commit()
            finally:
                await conn.close()
        return cache_id

    async def save_cache(
        self, request: ChatCompletionRequest, response: ChatCompletionResponse,
        client_id: str, owner_uid: str, request_id: str | None = None,
        replace_existing: bool = False,
        selected_chat_id: str | None = None,
    ) -> None:
        """Save a newly generated response once for this user's normalized prompt."""
        prompt = self._extract_prompt(request)
        if prompt and self._reusable(response):
            context_hash = self._cache_scope(request)
            await self._store_prompt_cache(
                prompt, response, client_id, owner_uid, context_hash, request_id,
                replace_existing=replace_existing or is_complete_code_request(prompt),
                selected_chat_id=selected_chat_id,
            )
            await db.clear_cache_exclusion(owner_uid, prompt, context_hash)
