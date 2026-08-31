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
    # re-invoked WITHOUT tools so it must produce a final text answer. A CEILING, not
    # a target: simple chats use ~0-1, SEO audits ~4; only the tool-heaviest workflows
    # (a research + quality-gated blog: research -> write -> score -> up to 3 targeted
    # fix/rescore cycles) use the headroom. The blog fix loop caps itself at 3 cycles
    # in-prompt, so this never becomes unbounded regeneration.
    ai_agent_max_steps: int = 12
    # Phase 6: max tool calls executed in ONE step (assistant message). A model
    # that emits more gets the first N run and the rest refused with a paired
    # error — bounds a degenerate 50-fan-out (duration/ledger/memory). Generous:
    # real turns emit a handful. 0 = unlimited.
    ai_agent_max_tool_calls_per_step: int = 24
    # Phase 7: max tool calls that run SIMULTANEOUSLY within one step. The batched
    # (independent) calls of one assistant message run concurrently, bounded by
    # this semaphore. Sized to the Ollagraph adapter pool (16 conns) so a whole
    # step's independent checks run at once; beyond the pool concurrency just
    # queues. 0/1 = sequential (no concurrency). Kept in lockstep with
    # ExecutionPolicy/DEFAULT_AGENT (spec.py) + the grounding test (test_agent.py).
    ai_agent_max_concurrent_tools: int = 16
    # Per-tool result is truncated to this many chars of serialized JSON before
    # it re-enters the context as a ToolMessage (bounds runaway tool output).
    ai_agent_tool_result_max_chars: int = 8000
    # How many discovered candidates are bound to the model per turn (never 223).
    ai_agent_discovery_top_k: int = 5
    # Phase 10 — orchestrator + dynamic capability routing. `capability_working_set`
    # is how many capabilities are INLINED per step (the render limit); it is NOT a
    # reachability ceiling — `find_capabilities` reaches the rest of the registry on
    # demand and dynamically loads them. The others bound the orchestrator loop.
    ai_capability_working_set: int = 8
    ai_orchestrator_max_steps: int = 6
    ai_orchestrator_max_delegation_depth: int = 2
    ai_orchestrator_max_parallel_branches: int = 4
    # Phase 11 — skills (reusable trusted guidance). `max_active` bounds how many
    # skills' full instructions compose into ONE request (never all registered);
    # `min_score` is the tag-anchored activation threshold; `budget_chars` caps the
    # composed guidance block so the prompt is bounded at 5 or 500 skills.
    ai_skill_max_active: int = 3
    ai_skill_min_score: float = 0.2
    # Sized to fit the whole activated SEO skill (~17k chars: methodology + full
    # diagnostic routing + capability_summary + checks_digest + constraints + the
    # dynamic report template). At 6000 the block was hard-truncated mid-checks_digest
    # by render_skills_block, silently dropping the constraints + output guidance from
    # the prompt. This is a CAP, not a floor — small skills don't grow to fill it; only
    # the large SEO skill uses the headroom, and only on SEO-activated requests.
    ai_skill_instructions_budget_chars: int = 20000
    # Phase 12b (Stage 1) — wire the orchestrated runtime's DYNAMIC CAPABILITY
    # DISCOVERY into the LIVE agent path. OFF by default → the runner is
    # byte-identical (top-K remains the initial inline set). When on (and the agent
    # is enabled with a tool registry), the runner binds `find_capabilities` +
    # attaches the CapabilityResolver, so the model can reach ANY registered tool
    # (no Top-K reachability ceiling) — streaming preserved (the non-streaming
    # `llm_for_tools` is rebound; the final answer still streams).
    ai_orchestrated_runtime_enabled: bool = False
    # Phase 1 (runtime v2) — opt-in gate for the corrected generic runtime: one
    # shared `Orchestrator.prepare`, skills decoupled from Ollagraph readiness, a
    # single `build_live_agent_env` factory feeding the delegator (so sub-agents keep
    # approvals/RAG/memory/resume/budget), execution lineage, cross-agent usage
    # aggregation, the total-deadline armed before prep, and capability-intent
    # resolution. OFF by default => runtime is byte-identical to today. Provider-
    # neutral tool machinery is byte-identical for the single-provider config and
    # is NOT gated by this flag.
    ai_runtime_v2_enabled: bool = False
    # File Generation System — when on (+ agent enabled), the model gains a
    # `generate_file` tool that renders a downloadable file (PDF/DOCX/XLSX/PPTX/…)
    # from a structured spec via deterministic Python renderers. OFF by default →
    # the tool is not bound and the runner is byte-identical. `max_bytes` is an
    # INFRA safety cap on the rendered blob (configurable, NOT a page/row/slide
    # limit); `timeout_s` bounds one render in the process pool.
    ai_file_generation_enabled: bool = False
    ai_file_max_bytes: int = 25_000_000
    ai_file_gen_timeout_s: float = 60.0
    # Phase 2 (SEO) — opt-in gate for the ONE read-only SEO skill + ONE SEO
    # specialist agent (app/seo/). OFF by default => neither is registered, the SEO
    # intents stay dormant, and the roster/delegate enum are byte-identical. When on
    # (and the orchestrated v2 runtime is enabled, which is what actually delegates),
    # the SEO skill activates by tags and delegate_to_agent('seo', ...) becomes
    # available. Read-only end to end; no VM deploy until phase 7.
    ai_seo_enabled: bool = False
    # Blog Assistant — opt-in gate for the ONE read-only, model-routed blog skill
    # (write/analyze/rewrite/strategy/brief/outline/seo-check/schema/persona/brand/geo
    # + research/factcheck/cluster/repurpose/audit/cannibalization/freshness/translate).
    # OFF by default => byte-identical to today; the SEO Assistant is separate + intact.
    ai_blog_enabled: bool = False
    # Deep Research — opt-in gate for the ONE optional, read-only, model-routed deep-
    # research skill (app/research/): decompose → parallel multi-source acquisition →
    # provenance → freshness → conflict/gap loop → citation verification → cited
    # synthesis, with DURABLE, resumable state. OFF by default => the skill + its
    # intents + the record_research checkpoint tool are never registered, so the
    # runner is byte-identical and the SEO/Blog skills are untouched. It only ENGAGES
    # when a request genuinely needs multi-source research (discovery tag-gate + the
    # skill's own STEP-0 self-gate) — simple requests stay on the fast path.
    ai_research_enabled: bool = False
    # Deep-Research SAFETY CEILINGS (not targets). The model chooses depth dynamically
    # UP TO these; the record_research checkpoint enforces them and stops gracefully.
    # These are IN ADDITION to the shared per-turn ceilings (ai_agent_max_steps,
    # ai_agent_max_tool_calls_per_step, ai_agent_total_deadline_s, token/turn budgets).
    ai_research_max_sources: int = 40  # max distinct sources read across one run
    ai_research_max_branches: int = 8  # max parallel research branches (sub-questions)
    # Data Analysis — opt-in gate for the conversational data-analyst capability
    # (app/data/): a deterministic compute layer (pandas/scipy/DuckDB) exposed as
    # reserved tools + a methodology skill, so the model reasons over COMPUTED results
    # of an uploaded CSV/XLSX instead of inlined data. OFF by default => the tools +
    # skill are never registered, the dataset context is never built, tabular files
    # inline exactly as today, and the runner is byte-identical. When ON, a tabular
    # attachment is registered as a dataset (only a compact preview is inlined) and
    # the compute tools/skill activate. SEO/Blog/Research are untouched.
    ai_data_analysis_enabled: bool = False
    # Compute SAFETY LIMITS (code-enforced). Rows are capped at READ time so a huge
    # file never fully parses (memory safety on the single-worker plane); results are
    # capped so tool output never blows context; a per-op timeout + a bounded compute
    # semaphore keep the event loop responsive; the df LRU avoids re-parsing across
    # tool calls within a turn (and follow-ups).
    ai_data_max_rows: int = 1_000_000  # max rows read from a dataset (truncate + flag)
    ai_data_result_max_rows: int = 200  # max rows any tool returns to the model
    ai_data_result_max_chars: int = 12_000  # hard cap on a serialized tool result
    ai_data_preview_rows: int = 10  # sample rows inlined instead of the full file
    ai_data_timeout_s: float = 20.0  # per-compute-op wall-clock ceiling
    ai_data_max_concurrent: int = 4  # bounded parallel compute ops (memory guard)
    ai_data_cache_max: int = 6  # datasets held in the per-process df LRU
    ai_data_max_datasets: int = 12  # most-recent tabular files surfaced per thread
    # Sales Assistant — opt-in gate for the ONE read-only, model-routed sales skill
    # (app/sales/): account/prospect research, call prep, research-first outreach,
    # call summary, pipeline review, weighted forecast, competitive intelligence,
    # sales assets, daily briefing, deal strategy. NO MCP/CRM connectors. OFF by
    # default => the skill + its `sales.*` intents are never registered, so the runner
    # is byte-identical and SEO/Blog/Research/Data are untouched. When ON, the skill
    # activates by sales tags and reuses the shared web tools, the Data-Analysis
    # compute tools (CSV forecast/pipeline math), `generate_file` (assets) and the
    # `remember` tool (seller context).
    ai_sales_enabled: bool = False
    # HR Assistant — opt-in gate for the ONE read-only, model-routed HR skill
    # (app/hr/): recruiting pipeline, interview prep, offers, onboarding, performance
    # reviews, policy/handbook Q&A, compensation analysis/benchmarking, people
    # analytics and org planning. NO MCP/HRIS/ATS connectors. OFF by default => the
    # skill + its `hr.*` intents are never registered, so the runner is byte-identical
    # and SEO/Blog/Research/Data/Sales are untouched. When ON, the skill activates by HR
    # tags and reuses the shared web tools, the Data-Analysis compute tools (people +
    # comp CSV math), `generate_file` (docs) and the `remember` tool (HR context).
    ai_hr_enabled: bool = False
    # Finance capability — opt-in gate for the TWO read-only, model-routed finance
    # skills (app/finance/): the corporate-Finance skill (FP&A statements/ratios/DCF,
    # budget variance, forecasting, SaaS metrics, investment appraisal) and the
    # Equity-Research skill (sector-relative, filings-first listed-stock analysis). NO
    # MCP/ERP/accounting/market-data connectors. OFF by default => neither skill, its
    # `finance.*` intents, nor the reserved `finance_calc` / `finance_reference` tools
    # are registered, so the runner is byte-identical and SEO/Blog/Research/Data/Sales
    # /HR are untouched. When ON, the skills activate by finance/equity tags and reuse
    # shared web tools, the Data-Analysis compute tools (CSV/XLSX aggregation),
    # `generate_file` (reports) and the `remember` tool (finance context); all numeric
    # math is the deterministic `finance_calc` tool, and bundled sector/valuation
    # methodology is served by `finance_reference`.
    ai_finance_enabled: bool = False
    # Marketing capability — opt-in gate for the ONE read-only, model-routed marketing
    # skill (app/marketing/): strategy/PMM (ICP/positioning/messaging/GTM/launch/
    # competitive), demand-gen & paid media, social & channel strategy, content
    # strategy, CRO, pricing, growth, AEO and marketing analytics. It COMPOSES with the
    # existing SEO/Blog/Deep-Research/Data-Analysis/Sales/Finance skills (never forks
    # them). NO MCP / ads/analytics/CRM connectors. OFF by default => neither the skill,
    # its `marketing.*` intents, nor the reserved marketing_calc / marketing_reference
    # tools are registered, so the runner is byte-identical and every sibling is
    # untouched. When ON, the skill activates by marketing tags, computes via
    # `marketing_calc`, pulls specialist playbooks via `marketing_reference`, and reuses
    # Data-Analysis (CSV) + `finance_calc` (CAC/LTV/ROI) + `generate_file` + `remember`.
    ai_marketing_enabled: bool = False
    # Operations capability — opt-in gate for the ONE read-only, model-routed operations
    # skill (app/operations/): vendor review, process docs/SOP/RACI, process optim,
    # change management, capacity/resource planning, status reports, operational risk,
    # compliance tracking (India-first) and runbooks. It COMPOSES with the existing
    # Data-Analysis/Finance/HR/Sales/Deep-Research skills (never forks them). No MCP,
    # ITSM or tracker connectors, no deterministic tool. OFF by default =>
    # neither the skill nor its `operations.*` intents are registered, so the runner is
    # byte-identical and every sibling is untouched. When ON, the skill activates by ops
    # tags, reuses Data-Analysis (workload/utilization), `finance_calc` (TCO/cost),
    # `generate_file` (SOPs/runbooks/reports), `remember` (ops context) and shared web
    # tools (vendor / current-compliance research). Leanest integration (HR pattern):
    # config + roster only.
    ai_operations_enabled: bool = False
    # Documents capability — opt-in gate for the ONE model-routed Documents skill
    # (app/documents/): PPTX + PDF create / read / edit / process / convert with REAL
    # inline slide+page preview in the chat UI. It steers the model to the extended
    # `generate_file` (create) + the new `document_ops` reserved tool (read/edit/merge/
    # split/rotate/extract/tables/OCR/forms/convert), reusing the deployed python-pptx /
    # pypdf / pdfplumber / pypdfium2 / rapidocr — NO new Python dependency. Composes
    # with
    # Finance/Research/Marketing/Operations/Data (content in, artifact out). OFF by
    # default => neither the skill, its `documents.*` intents, nor `document_ops` are
    # registered, so the runner is byte-identical and every sibling is untouched.
    ai_documents_enabled: bool = False
    # The faithful PPTX visual-preview + PPTX<->PDF path uses LibreOffice headless
    # (soffice), sandboxed per-conversion (systemd-run scope: PrivateNetwork + MemoryMax
    # + CPUQuota + ProtectSystem + NoNewPrivileges, else unshare -n + prlimit) with a
    # hard
    # Python timeout. Kept on a SEPARATE flag so the capability works (download +
    # faithful
    # PDF preview + LABELED-approximate generated-deck preview) even before the binary
    # is
    # installed/verified. OFF => no soffice call; uploaded/edited-deck visual preview
    # and
    # PPTX->PDF are unavailable (honestly reported), never faked.
    ai_documents_soffice_enabled: bool = False
    # document_ops resource bounds (untrusted files). preview page/slide cap; preview
    # render scale (pypdfium2, below the 2.0 OCR scale); per-op + soffice timeouts; max
    # input file size; concurrent soffice processes (memory-heavy).
    ai_documents_preview_max_pages: int = 10
    ai_documents_preview_scale: float = 1.5
    ai_documents_op_timeout_s: float = 60.0
    ai_documents_soffice_timeout_s: float = 45.0
    ai_documents_max_file_bytes: int = 25_000_000
    ai_documents_soffice_concurrency: int = 1
    # Phase 7 (SEO mutations) — opt-in gate for OPTIONAL, approval-gated site changes
    # (update metadata / structured data / redirects / content). OFF by default => the
    # write tools + SeoWriteAdapter are never bound, so the runner is byte-identical and
    # background/monitoring SEO stays hard read-only. When ON, the write tools are bound
    # ONLY on an interactive chat turn and every write goes through the durable approval
    # round-trip (NEEDS_APPROVAL); nothing runs autonomously.
    ai_seo_mutations_enabled: bool = False
    # Core capabilities ALWAYS made available to the agent (independent of whether
    # the user's wording lexically matches them). Each string is a canonical intent;
    # the top discovery hit for it is unioned into the working set every agent turn.
    # Fixes the class of bug where "what is the current price of X" surfaced no web
    # tool (n_scored=0) because the query shares no tokens with the search tool, so
    # the user had to say "search on web". Verified on the live catalogue: "search
    # the web" -> search_endpoint_v1_search_post (0.675). Add intents to cover more
    # core capabilities; the long tail stays reachable via find_capabilities.
    ai_agent_core_capability_queries: list[str] = ["search the web"]
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
    # Phase 2: at-most-once for side effects. When FALSE (default), an AMBIGUOUS
    # outcome (timeout/5xx/transport/2xx-unreadable) on a non-idempotent
    # SIDE-EFFECTING tool is NOT auto-retried — it is recorded INDETERMINATE, so
    # the effect count stays 0-or-1. Read-only tools always retry. Set true only
    # if a provider's retries are known safe (it is not, for Ollagraph).
    ai_agent_retry_ambiguous_side_effects: bool = False
    # Phase 8: durable approval round-trip. TTL for a parked approval — a human
    # deliberation window, kept well above the 300s execution deadline so the two
    # never collide. `approval_test_tool_ids` promotes otherwise READ_ONLY tools
    # to approval-gated so the round-trip is verifiable on staging WITHOUT
    # shipping a real high-impact tool; it is empty in production.
    ai_agent_approval_ttl_s: float = 900.0
    ai_agent_approval_test_tool_ids: frozenset[str] = frozenset()
    # When true, the agent may propose EXTERNAL_SIDE_EFFECT web tools
    # (scrape/analyze/extract) — every one goes through the approval round-trip
    # (never auto-run), and HIGH_IMPACT tools (billing/keys/auth) stay disabled.
    # Off by default: the safe posture is read-only tools only.
    ai_agent_side_effect_enabled: bool = False
    # Phase 8: observability. When set, the inference plane reports unhandled
    # errors to GlitchTip/Sentry (events scrubbed through the log redactor first).
    # Empty by default and in CI; the SDK is an optional import, so nothing is
    # required unless an operator both installs sentry-sdk and sets this DSN.
    ai_sentry_dsn: str = ""

    # Keep in step with DEFAULT_MODEL in convex/chat/authz.ts — this one drives
    # the scheduling parser, and production had it set to a model id the
    # provider does not accept at all, so every parse silently degraded to the
    # manual form.
    ai_default_model: str = "glm-5.2"
    # The scheduling-intent parser's model, pinned SEPARATELY from the chat
    # default so a future change to chat cannot silently degrade parsing into
    # the fabricating manual-form fallback. Empty = follow ai_default_model.
    ai_schedule_model: str = ""
    # Tried once when the primary parser model's provider fails. A 502 from
    # the upstream is what put every user into the raw-sentence fallback.
    # Empty disables the second attempt.
    ai_schedule_model_fallback: str = "glm-5.2"
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
    def artifact_url(self) -> str:
        # Generated-file store: Python POSTs the rendered blob here (streamId-scoped).
        return f"{self.convex_internal_url.rstrip('/')}/ai/artifact"

    @property
    def seo_artifact_url(self) -> str:
        # Phase 5: durable-run crawl artifact store (runId + leaseToken scoped; owner
        # derived from the seoRuns row, so it does NOT depend on the enqueuing stream).
        return f"{self.convex_internal_url.rstrip('/')}/ai/seo-artifact"

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

    # --- Scheduled Tasks (Phase 1: scheduling foundation only) -------------
    # OFF by default => the scheduler process registers no schedule and no
    # queue, so an unconfigured deployment is byte-identical to today. Phase 1
    # executes NOTHING: the occurrence lifecycle runs end to end against a
    # no-op executor, and Phase 2 swaps in the real AI execution behind the
    # same OccurrenceExecutor seam.
    ai_scheduled_tasks_enabled: bool = False
    # DBOS system database. Postgres in production (a dedicated `myos_dbos`
    # beside the knowledge DB); blank => an on-disk SQLite file, which is what
    # the hermetic tests use. CARRIES A PASSWORD — listed in secrets() below.
    scheduler_database_url: str = ""
    # 6-field cron (seconds first). A 30s heartbeat bounds how late a due
    # occurrence starts; correctness never depends on it, only latency.
    scheduler_tick_cron: str = "*/30 * * * * *"
    scheduler_queue_name: str = "scheduled_tasks"
    # Cross-task parallelism. Deliberately far below the chat plane's
    # ai_max_concurrent_global (32): scheduled work is unattended and must
    # never be able to crowd out a user waiting on a live answer.
    scheduler_global_concurrency: int = 4
    # Per-task concurrency is ALWAYS 1 (queue partitioning) and is not
    # configurable — overlapping runs of one task are a correctness bug, not a
    # tuning choice. This is the per-USER ceiling.
    scheduler_max_per_user: int = 1
    # Occurrences materialised per task per tick. A long outage is CHUNKED
    # across ticks, never dropped: the cursor parks on the last one written.
    scheduler_materialize_limit: int = 200
    scheduler_claim_limit: int = 5
    scheduler_task_page: int = 100
    # Liveness cadence. Must stay well under LEASE_TTL_MS in
    # convex/scheduled/occurrences.ts or the reaper will steal live work.
    scheduler_heartbeat_s: float = 30.0
    # "chat" runs a real AI turn through the existing execution path; "noop" is
    # the Phase 1 lifecycle-only executor, kept for tests.
    scheduler_executor: str = "chat"
    # Per-turn budget for a SCHEDULED run. Chat keeps its 300s cap; a scheduled
    # deep-research or SEO audit legitimately runs longer. This value is written
    # to chatStreams.deadlineAt, which is the whole chain: the Python runner
    # adopts it (runner._compute_deadline_mono) and the Convex stall reaper fails
    # a past-deadline turn. Phase 1's 300s lease is unaffected because the
    # occurrence heartbeats every 30s throughout.
    scheduler_turn_deadline_ms: int = 1_200_000
    # How often the executor polls the turn for a terminal state. Coarse on
    # purpose: this is a background job, and each poll is a Convex mutation.
    scheduler_poll_interval_s: float = 3.0
    # Loopback-only health/readiness for the scheduler. NOT DBOS own admin
    # server: that one hard-binds 0.0.0.0 and exposes workflow recovery,
    # garbage collection, global-timeout and deactivate with no auth.
    scheduler_health_port: int = 8771

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

    @property
    def schedule_model(self) -> str:
        """The parser's model: its own setting, else the chat default."""
        return self.ai_schedule_model or self.ai_default_model

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
                # Same: the DBOS system database URL embeds its password.
                self.scheduler_database_url,
                # Ollagraph Bearer key (osk_...). Discovery is key-less, but the
                # key must never reach logs if a future execution path uses it.
                self.ollagraph_api_key,
            )
            if s
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
