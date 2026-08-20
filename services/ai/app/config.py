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

    # --- OpenRouter --------------------------------------------------------
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_app_url: str = "https://app.ollasuper.com"
    openrouter_app_title: str = "myos"

    ai_default_model: str = "anthropic/claude-opus-5"
    # Title generation model — intentionally a tiny/fast model (Gemini Flash).
    ai_title_model: str = "google/gemini-2.0-flash-001"
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
    ai_ocr_model: str = "google/gemini-2.0-flash-001"
    ai_ocr_long_edge: int = 2048

    # Ingestion limits (app/ingest/). One shared char budget per file, mirroring
    # ai_max_turn_chars for attachments.
    ai_ingest_chunk_tokens: int = 800
    ai_ingest_chunk_overlap: int = 120
    ai_ingest_max_chars: int = 500_000
    ai_ingest_max_chunks: int = 2_000
    ai_ingest_parse_timeout_s: float = 20.0
    ai_ingest_embed_batch: int = 64
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
    ai_rag_context_tokens: int = 4_000
    ai_rag_max_chunk_tokens: int = 700
    ai_rag_min_query_chars: int = 16  # skip retrieval for trivial queries
    ai_rag_deadline_ms: int = 800  # proceed with NO rag if retrieval exceeds this

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
                self.ai_service_key,
                self.ai_ingress_secret,
                # Carries the DB password — must never reach journalctl.
                self.knowledge_database_url,
            )
            if s
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
