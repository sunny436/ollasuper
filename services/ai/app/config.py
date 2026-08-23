"""Runtime configuration.

Everything is environment-driven; nothing here has a secret default. The
OpenRouter key in particular is never generated, never defaulted and never
written by a deploy script — the service refuses to start without one.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # --- binding -----------------------------------------------------------
    # Loopback by default. Convex (:3210/:3211), Next (:3000) and this service
    # all live on the same host, so the service key never crosses a network
    # segment. This single line removes more attack surface than anything else
    # in the service.
    #
    # NOT :8000 — deploy/47-glitchtip.sh publishes GlitchTip on 8000 and
    # cf-glitch.service tunnels http://localhost:8000 to a public
    # trycloudflare.com URL. Whichever process binds first wins; if it were this
    # one, the entire inference plane (service-key auth only, no CORS, no
    # per-user authz) would be reachable from the internet.
    ai_bind_host: str = "127.0.0.1"
    ai_port: int = 8770

    # --- server-to-server auth --------------------------------------------
    ai_service_key: str = ""  # Convex -> here   (x-service-key)
    ai_ingress_secret: str = ""  # here -> Convex (x-ai-key)

    # --- Convex ------------------------------------------------------------
    # Two separate URLs on purpose. The issuer must match the JWT byte-for-byte
    # (deploy/28-fix-issuer.sh exists, so this has bitten before), while all
    # outbound calls should stay on loopback and survive the Caddy / Cloudflare
    # cutovers that rewrite the public origin.
    convex_site_url: str = "http://127.0.0.1:3211"
    convex_internal_url: str = "http://127.0.0.1:3211"
    convex_audience: str = "convex"

    # --- OpenRouter (embeddings, title-gen, OCR) ---------------------------
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_app_url: str = "https://app.ollasuper.com"
    openrouter_app_title: str = "myos"

    # --- Ollima (user-chat generation ONLY) --------------------------------
    # OpenAI-compatible gateway (TensorZero-backed). Chat REQUIRES a Bearer key
    # (401 without). Operator-filled; never generated, defaulted or logged.
    # Title-gen, OCR and embeddings deliberately stay on OpenRouter.
    ollima_api_key: str = ""
    ollima_base_url: str = "https://api.ollima.com/v1"

    # --- Ollagraph tool provider (Phase 1: discovery/registry ONLY) --------
    # Web-intelligence platform (scrape/extract/intel/actors/...). Phase 1 only
    # DISCOVERS its capabilities into the Tool Registry from the PUBLIC OpenAPI
    # spec — no key is needed to discover, and NOTHING here is wired to the LLM.
    # The key is stored for a FUTURE execution phase and is never logged or sent
    # to the browser/model. Feature is OFF unless ollagraph_base_url is set.
    ollagraph_api_key: str = ""
    ollagraph_base_url: str = ""
    # Blank -> derived from base_url as `${base}/openapi.json` (see property).
    ollagraph_openapi_url: str = ""
    # Timeout (seconds) for the one-shot spec fetch at startup discovery.
    ollagraph_discovery_timeout_s: float = 15.0
    # Default per-tool timeout when a tool's request schema declares none.
    ollagraph_default_tool_timeout_s: float = 30.0

    # --- Tool discovery / selection (Phase 2: metadata-only, provider-agnostic)
    # Deterministic selection over the cached Tool Registry. No execution, no LLM.
    tool_discovery_default_top_k: int = 5
    tool_discovery_max_top_k: int = 25
    # Below this normalized [0,1] relevance a query is treated as no-match.
    tool_discovery_min_score: float = 0.2

    # --- Agent core (Phase 4: bounded single-agent tool loop) --------------
    # OFF by default. Even when on, the agent only engages when the registry is
    # populated AND an Ollagraph key is present (see `agent_enabled`); otherwise
    # generation is byte-identical to the pre-Phase-4 prepare->model->END path.
    # Discovery is filtered to READ_ONLY tools, policy is enforced OUTSIDE the
    # model, and high-impact/approval tools are never silently executed.
    ai_agent_enabled: bool = False
    # Hard ceiling on model<->tool round-trips per turn. At the cap the model is
    # re-invoked WITHOUT tools so it must produce a final text answer.
    ai_agent_max_steps: int = 4
    # Per-tool result is truncated to this many chars of serialized JSON before
    # it re-enters the context as a ToolMessage (bounds runaway tool output).
    ai_agent_tool_result_max_chars: int = 8000
    # How many discovered candidates are bound to the model per turn (never 223).
    ai_agent_discovery_top_k: int = 5
    # Phase 5: expose the EXISTING RAG as an agent-decided `search_knowledge`
    # tool instead of the always-on pre-run injection. OFF by default → the
    # pre-run RAG path (below) runs byte-identically. When on (and the user has
    # ready files), the agent decides whether to retrieve, pre-run is skipped,
    # and retrieval reuses retrieve_context/render_rag_block unchanged. Decoupled
    # from ai_agent_enabled: RAG-as-tool works with or without Ollagraph.
    ai_agent_rag_tool_enabled: bool = False
    # Phase 6: expose long-term memory as agent-decided `search_memory` +
    # `remember` tools. OFF by default → no memory tools are bound and the turn
    # is byte-identical to before. Also gated per-user by `memoryEnabled` on the
    # request (Convex chatSettings), so a user can disable memory entirely.
    ai_agent_memory_tool_enabled: bool = False
    # Phase 7 — durable multi-step execution.
    # Total wall-clock deadline for one turn (model↔tool loop). Enforced in the
    # runner (self-terminate → TIMED_OUT) AND durably via chatStreams.deadlineAt
    # (the Convex reaper fails, not resumes, a turn past deadline). This is the
    # single aggregate cap the system lacked — component timeouts don't sum.
    ai_agent_total_deadline_s: float = 300.0
    # Bounded retry for a RETRYABLE ToolError (timeout/rate_limited/upstream/
    # unavailable). Non-retryable errors (auth/invalid/schema) never retry.
    ai_agent_tool_max_retries: int = 2
    ai_agent_tool_retry_base_s: float = 0.5
    # Phase 8: durable approval round-trip. TTL for a parked approval — a human
    # deliberation window, kept well above the 300s execution deadline so the two
    # never collide. `approval_test_tool_ids` promotes otherwise READ_ONLY tools
    # to approval-gated so the round-trip is verifiable on staging WITHOUT
    # shipping a real high-impact tool; it is empty in production.
    ai_agent_approval_ttl_s: float = 900.0
    ai_agent_approval_test_tool_ids: frozenset[str] = frozenset()

    ai_default_model: str = "gpt-5.6-luna"
    # Title generation model — intentionally a tiny/fast model (Gemini Flash).
    # NOTE: gemini-2.0-flash-001 was RETIRED by OpenRouter (404 "No endpoints
    # found"); the live successor is gemini-2.5-flash-lite (multimodal, cheap).
    # The VM also sets AI_TITLE_MODEL, but this default must not be a landmine
    # on a fresh box.
    ai_title_model: str = "google/gemini-2.5-flash-lite"
    ai_max_output_tokens: int = 8192

    # --- context -----------------------------------------------------------
    # 32k, not 1M. At Opus-5 input rates a full 32k context is ~$0.16/turn;
    # 1M would be $5.00 per message. A 32k window holds ~60 turns of ordinary
    # chat, far past the point where a rolling summary is the better tool.
    ai_context_budget_tokens: int = 32_000
    # The budget above bounds PRIOR turns. This bounds the newest one, which is
    # where every user-controlled byte actually is: MAX_CONTENT (100k chars) +
    # 6 attachments x MAX_PDF_CHARS (60k) = 460k chars ~ 115k input tokens, or
    # ~$0.58 of Opus input on a single send, versus the ~32k this config claims
    # is the ceiling. Trimming history while letting the current turn through
    # unbounded controls the wrong half.
    ai_max_turn_chars: int = 48_000
    # count_tokens_approximately is calibrated for OpenAI-ish tokenizers and
    # undercounts Claude. There is no Claude tokenizer available through
    # OpenRouter, so approximate and pad. Re-measure against usage.prompt_tokens
    # on real traffic and tune.
    ai_token_safety_factor: float = 1.35

    # --- delta writer ------------------------------------------------------
    # See app/runtime/writer.py for why these specific numbers. The interval is
    # a latency ceiling, not the primary trigger: at a realistic ~280 chars/s a
    # 100ms floor fires before the 96-char target every time and produces
    # ~32-char batches (measured: 236 flushes on an 8k answer, ~944KB
    # downstream per viewer). 300ms lets the size branch win normally while a
    # slow stream still repaints ~3x/sec.
    ai_flush_min_interval_ms: int = 300
    ai_flush_max_interval_ms: int = 700
    ai_flush_min_chars: int = 96
    ai_flush_max_chars: int = 512
    ai_heartbeat_ms: int = 5_000
    ai_ingress_fail_deadline_s: float = 20.0
    ai_pending_cap_bytes: int = 256 * 1024

    # --- resource protection ----------------------------------------------
    # Policy (per-user quotas) belongs in Convex, where the authenticated
    # identity lives. These two exist only to stop one process being swamped.
    ai_max_concurrent_per_user: int = 2
    ai_max_concurrent_global: int = 32

    # --- attachments -------------------------------------------------------
    # pypdf extraction always works and needs no provider support. The
    # OpenRouter file-parser plugin path is gated behind this flag until a
    # probe confirms ChatOpenAI forwards both the unknown content-part dict
    # and extra_body.plugins untouched.
    ai_pdf_engine: str = Field(default="pypdf", pattern="^(pypdf|openrouter)$")
    ai_max_images_per_turn: int = 4
    ai_max_attachment_bytes: int = 20 * 1024 * 1024

    # --- observability -----------------------------------------------------
    ai_log_level: str = "INFO"
    # Off by default. Enabling it puts user message content in journalctl.
    ai_log_content: bool = False

    # --- File Knowledge System (RAG) --------------------------------------
    # Dedicated pgvector database (separate container, compose.knowledge.yml).
    # libpq URL, e.g.
    #   postgresql://myos_ai:...@127.0.0.1:5433/myos_knowledge?sslmode=disable
    # Empty disables RAG entirely (chat still works); the ingest/retrieve paths
    # no-op when unset, so a box without the container degrades gracefully.
    knowledge_database_url: str = ""

    # Embedding model + its native dimension. ONE source of truth — the dimension
    # is also baked into the Alembic migration (vector(N)); changing the model or
    # dimension requires a new migration + reindex + re-embed. Stored per-chunk
    # (embedding_model/embedding_dimensions) so old vectors stay distinguishable.
    openrouter_embedding_model: str = "openai/text-embedding-3-large"
    embedding_dimensions: int = 3072
    # OCR for images goes through an OpenRouter VISION model (no system binary).
    # Same retirement as the title model above — 2.0-flash-001 now 404s, which is
    # exactly why every image upload was failing. 2.5-flash-lite is live + vision.
    ai_ocr_model: str = "google/gemini-2.5-flash-lite"
    ai_ocr_long_edge: int = 2048
    # Scanned/image-only PDF pages are rendered (pypdfium2) then OCR'd. No hard
    # page cap (bounded instead by the 20MB file limit + overall deadline).
    ai_ocr_max_pdf_pages: int = 10  # legacy; unused by the no-page-limit path
    # LOCAL OCR is the PRIMARY engine: RapidOCR (Apache-2.0, ONNX-CPU, NO system
    # binary) keeps the scanned-PDF OCR flood OFF the shared OpenRouter account —
    # a sustained 55-page vision-OCR flood once queued an interactive chat's LLM
    # request for 179s (measured). Quality validated on scanned text (IDs, numbers,
    # currency read accurately). The vision model stays only as a per-page fallback
    # for empty/low-confidence pages, so it never floods the account.
    ai_ocr_engine: str = Field(default="rapidocr", pattern="^(rapidocr|vision)$")
    ai_ocr_min_confidence: float = 0.5
    ai_ocr_vision_fallback: bool = True
    # Bounded CPU pool for local OCR inference (ONNX releases the GIL during
    # inference; a small bound keeps it from monopolising the box).
    ai_ocr_local_concurrency: int = 4
    # pypdfium2 (libpdfium) can SEGFAULT on a malformed/edge-case page — a native
    # crash Python cannot catch, which would take down the whole --workers 1
    # service (chat included). So render pages in a bounded PROCESS pool: a
    # segfault kills only a worker (surfaced as BrokenProcessPool), the page is
    # skipped, and the pool is recreated. 0 = render in-thread (tests only).
    ai_ocr_render_workers: int = 2

    # Ingestion limits (app/ingest/). One shared char budget per file, mirroring
    # ai_max_turn_chars for attachments.
    ai_ingest_chunk_tokens: int = 800
    ai_ingest_chunk_overlap: int = 120
    ai_ingest_max_chars: int = 500_000
    ai_ingest_max_chunks: int = 2_000
    ai_ingest_parse_timeout_s: float = 20.0
    ai_ingest_embed_batch: int = 64
    # Embedding is the primary throughput lever: langchain's aembed_documents
    # awaits its 64-text batches SEQUENTIALLY (base.py:778, our
    # check_embedding_ctx_length=False path), so a large file waits one round
    # trip per batch. We run up to this many batches concurrently instead,
    # order-preserving, bounded so the provider's TPM/RPM (429s) is respected.
    # Tuned empirically by bench_ingest.py.
    ai_ingest_embedding_concurrency: int = 4
    # Interactive-priority provider governor. Interactive chat gets highest
    # priority + RESERVED provider capacity; background ingestion (embeddings +
    # any vision-OCR fallback) uses only the LEFTOVER (max - reserve), so it can
    # never exhaust the shared OpenRouter account and queue a chat request (the
    # measured 179s starvation). OCR is now local, so this mainly guards the rare
    # vision-fallback path. Sized to the provider's measured hard concurrency.
    ai_provider_max_concurrency: int = 8
    ai_provider_chat_reserve: int = 3
    # Scanned-PDF pages are OCR'd through a vision model — bounded-parallel, not
    # globally sequential. Bound respects the provider rate limit and memory
    # (each rendered page PNG is held only for its OCR call, then discarded).
    ai_ingest_ocr_concurrency: int = 6
    # Per-page OCR deadline. The shared LLM client allows 180s x 2 retries (~9
    # min for ONE page); an ingest cannot afford that, so cap each OCR call.
    ai_ingest_ocr_timeout_s: float = 45.0
    # Whole-file wall-clock ceiling, comfortably under the Convex stall reaper
    # (INGEST_STALL_MS = 10 min). On hit: persist what was processed + a truthful
    # "processed first N" note. Bounds cost and kills any runaway.
    ai_ingest_overall_deadline_s: float = 300.0
    # Progress writes hit a userFiles row that a usePaginatedQuery subscribes to,
    # so every write re-sends the whole list. Coalesce: emit at most one update
    # per this interval (stage transitions always flush).
    ai_ingest_progress_min_interval_ms: int = 750
    ai_max_ingests_per_hour: int = 60
    # Ingestion runs on its OWN concurrency pool so a burst of uploads cannot
    # starve chat generations (which use ai_max_concurrent_*).
    ai_ingest_max_concurrent_per_user: int = 1
    ai_ingest_max_concurrent_global: int = 4
    # OOXML (docx/xlsx are zip archives) decompression-bomb guards.
    ai_zip_max_entries: int = 2_000
    ai_zip_max_uncompressed_bytes: int = 200 * 1024 * 1024
    ai_zip_max_ratio: int = 120

    # --- retrieval (RAG at chat time) -------------------------------------
    # Fetch a wider candidate set, filter by a cosine-distance floor, keep top_k.
    # RAG context DISPLACES history against ai_context_budget_tokens (it does not
    # add on top), so the per-turn cost ceiling is unchanged.
    ai_rag_fetch_k: int = 20
    ai_rag_top_k: int = 6
    ai_rag_min_similarity: float = 0.35  # keep chunk iff distance <= 1 - this
    # Recall safety net. Meta-phrased questions ("in the file I uploaded, what is
    # the owner field?") dilute similarity against terse chunks and push the RIGHT
    # chunk over the strict floor — and NOT always to rank-1: the RAG eval measured
    # the correct chunk at rank-2 / distance 0.787 with junk at rank-1. So when
    # nothing clears the floor, keep the closest ai_rag_fallback_top_n chunks that
    # are at least this close (not just rank-1). The <retrieved_context> block
    # tells the model to ignore an irrelevant excerpt, so a few marginal keeps are
    # cheap; genuinely irrelevant chunks sit at 0.82+ and are still dropped.
    ai_rag_fallback_max_distance: float = 0.80
    ai_rag_fallback_top_n: int = 3
    ai_rag_context_tokens: int = 4_000
    ai_rag_max_chunk_tokens: int = 700
    # Skip retrieval only for TRULY trivial turns ("hi", "ok"). The RAG eval showed
    # 16 silently killed real short questions ("Owner?", "Budget?" — chunk at 0.55,
    # well under the floor): recall 0.69 -> 0.92, short-query recall 0.00 -> 1.00
    # when lowered. 4 still skips 1-3 char acknowledgements.
    ai_rag_min_query_chars: int = 4
    # Proceed with NO rag if retrieval exceeds this. Measured warm embedding
    # round-trip is ~300ms, but a COLD httpx connection to OpenRouter (first
    # query after idle: TLS handshake + DNS) plus the pgvector query can spike
    # past 800ms — which silently dropped recall on no-attachment questions (the
    # embedding there is on the critical path, with no attachment work to hide
    # behind). 2500ms comfortably covers a cold start; the cost is bounded worst-
    # case added latency only when the embed is genuinely slow.
    ai_rag_deadline_ms: int = 2500

    @property
    def ingress_url(self) -> str:
        return f"{self.convex_internal_url.rstrip('/')}/ai/ingress"

    @property
    def file_url(self) -> str:
        return f"{self.convex_internal_url.rstrip('/')}/ai/file"

    @property
    def ingest_file_url(self) -> str:
        # Sibling of /ai/file, scoped by an ingestId capability (not streamId).
        return f"{self.convex_internal_url.rstrip('/')}/ai/ingest-file"

    @property
    def rag_enabled(self) -> bool:
        return bool(self.knowledge_database_url)

    @property
    def ollagraph_enabled(self) -> bool:
        """Tool discovery is possible once a base URL is set (the spec is
        public, so no key is required to discover). Mirrors `rag_enabled`."""
        return bool(self.ollagraph_base_url)

    @property
    def agent_enabled(self) -> bool:
        """The agent EXECUTES tools, which requires a key — unlike discovery,
        which only needs the public spec. So this is stricter than
        `ollagraph_enabled`: the flag must be on, a base URL set, AND a key
        present. Off on any missing piece => the current no-tools chat path."""
        return (
            self.ai_agent_enabled
            and self.ollagraph_enabled
            and bool(self.ollagraph_api_key)
        )

    @property
    def ollagraph_spec_url(self) -> str:
        """Explicit override wins; otherwise derive `${base}/openapi.json`."""
        if self.ollagraph_openapi_url:
            return self.ollagraph_openapi_url
        return f"{self.ollagraph_base_url.rstrip('/')}/openapi.json"

    @property
    def knowledge_engine_url(self) -> str:
        """SQLAlchemy async URL. psycopg3 takes libpq params (incl. sslmode)
        directly, so — unlike asyncpg — no query-param translation is needed;
        only the driver scheme changes."""
        url = self.knowledge_database_url
        prefix = "postgresql://"
        if url.startswith(prefix):
            url = "postgresql+psycopg://" + url[len(prefix) :]
        return url

    def secrets(self) -> tuple[str, ...]:
        """Values the log redaction filter must never emit."""
        return tuple(
            s
            for s in (
                self.openrouter_api_key,
                self.ollima_api_key,
                self.ai_service_key,
                self.ai_ingress_secret,
                # Carries the DB password — must never reach journalctl.
                self.knowledge_database_url,
                # Ollagraph Bearer key (osk_...). Discovery is key-less, but the
                # key must never reach logs if a future execution path uses it.
                self.ollagraph_api_key,
            )
            if s
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
