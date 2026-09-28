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
    # The Convex API origin (the :3210 half, where /api/mutation lives), as
    # opposed to the HTTP-actions origin above. The hot ingress ops go here —
    # see clients/convex.py — because an HTTP action costs ~125 ms of runtime
    # overhead per call on this backend and a mutation over /api/mutation
    # costs ~10 ms (both measured on production).
    convex_api_url: str = "http://127.0.0.1:3210"
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
    # Timeout for CRAWLING tools, which fetch many pages per call and cannot
    # finish inside the 30s default — a site-wide broken-link audit timed out in QA
    # and only completed once the scan was manually narrowed.
    #
    # 90s, not more, and that ceiling is the point: the whole turn gets 300s
    # (ai_agent_total_deadline_s, and Convex sends the same 300_000ms), so one call
    # may take a large slice but must not consume the budget an agentic turn needs
    # for its remaining steps. Bounding the SCAN is the real fix — see the sizing
    # rule in app/seo/skill.py; this only stops a reasonable scan dying at 30s.
    ollagraph_crawl_tool_timeout_s: float = 90.0
    # Substrings identifying those tools in the discovered spec's operation ids.
    ollagraph_crawl_tool_markers: tuple[str, ...] = (
        "broken_links",
        "crawl",
        "sitemap",
    )
    # The PROCESS-WIDE outbound tool-connection pool (app.state.ollagraph_http is a
    # singleton, so this is shared by every concurrent stream, not a per-turn
    # budget). This is the ONE genuine infrastructure limit on Ollagraph
    # concurrency — sockets and in-flight response buffers — which is why
    # `ai_agent_max_concurrent_tools` is aligned to it rather than being a second,
    # independent cap. The value is httpx's own library default; the previous 16
    # was an OllaSuper choice that silently throttled every stream in the process.
    ollagraph_max_connections: int = 100
    # How long a QUEUED call may wait for a free connection. Deliberately separate
    # from the tool's execution timeout: httpx applies a bare float to every phase,
    # so pool waiting used to be charged to the tool's own budget (see call_tool).
    ollagraph_pool_acquire_timeout_s: float = 30.0
    # Floor for the adaptive concurrency gate. The gate halves in-flight
    # concurrency on a provider 429 and re-grows on sustained success (AIMD), so
    # the provider's real capacity — not a configured guess — decides how wide the
    # fan-out runs. This floor only stops it collapsing to zero.
    ollagraph_min_concurrency: int = 2

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
    # Emergency backstop on model<->tool round-trips per turn. 0 (the default) means
    # NO count ceiling — a turn runs as many steps as it keeps making PROGRESS for.
    #
    # This was a hard 12, which is what actually broke long deliverables: a research
    # -> write -> score -> fix workflow spent its budget on research, and at the cap
    # the model was silently re-invoked WITHOUT tools. It could no longer call
    # generate_file (so it announced it would "write the post myself"), and with no
    # tool able to run it could not emit another tool event either — which, before
    # the deadline became progress-rolled, also froze its own watchdog.
    #
    # A count cannot tell useful work from a loop. `ai_agent_max_stall_steps` can:
    # a step that produces no new successful tool result is not progress, and a few
    # of those in a row is a loop. Convergence is bounded by that, by the no-progress
    # deadline, and by the context/cost budget — all real signals.
    #
    # A NON-ZERO BACKSTOP since the MCP audit (H-09): a hostile connector can
    # feed the loop `is_error` results forever and the convergence criteria
    # above are then the only bound. 40 is far above any legitimate SEO or
    # research run measured on production and far below "until the deadline".
    ai_agent_max_steps: int = 40
    # Consecutive UNPRODUCTIVE steps (no successful, non-duplicate tool result)
    # tolerated before the loop is stopped and the model must answer in text. This
    # is a convergence criterion, not a work ceiling: a productive step resets it,
    # so genuinely long work is unbounded while a stuck loop still terminates.
    ai_agent_max_stall_steps: int = 2
    # Emergency backstop ONLY — 0 (the default) means unlimited, and unlimited is
    # the intended operating mode. A batch wider than the concurrency budget is
    # QUEUED by the executor's semaphore, not refused; the natural bound on one
    # assistant message's fan-out is the model's own output-token ceiling.
    #
    # This used to default to 24 and REFUSE the overflow with a paired error, which
    # punished exactly the batching PARALLEL_TOOL_GUIDANCE asks for, surfaced as
    # failed tool runs in the UI, and cost another step to re-emit work already
    # decided on. Set non-zero only to contain a genuinely degenerate model.
    # Since the MCP audit (H-09): 32, not 0. Batching is still unpunished — no
    # real assistant message has come near 32 parallel calls — and a degenerate
    # model or an injected fan-out is contained.
    ai_agent_max_tool_calls_per_step: int = 32
    # Max tool calls that run SIMULTANEOUSLY within one step. Aligned to
    # `ollagraph_max_connections` so a whole step's independent calls launch at
    # once and the CONNECTION POOL (plus the adaptive 429 gate) is the single real
    # limiter — not a second, independent product cap that silently throttled a
    # step to 16 while 32 streams oversubscribed the same 16-socket pool.
    # 0/1 = sequential. Kept in lockstep with ExecutionPolicy/DEFAULT_AGENT
    # (spec.py) + the grounding test (test_agent.py).
    ai_agent_max_concurrent_tools: int = 100
    # Per-tool result is truncated to this many chars of serialized JSON before
    # it re-enters the context as a ToolMessage (bounds runaway tool output).
    ai_agent_tool_result_max_chars: int = 8000
    # How many discovered candidates are bound to the model per turn. 0 = NO count
    # limit: relevance (`tool_discovery_min_score`) plus the SCHEMA-TOKEN BUDGET
    # below decide what binds, and the token budget is a real constraint where a
    # count is not.
    #
    # This was 5 — out of ~223 discovered Ollagraph tools — which meant a task
    # needing the sixth-most-relevant tool could not see it at all, and had to
    # spend one of its scarce steps on `find_capabilities` to reach it.
    ai_agent_discovery_top_k: int = 0
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
    # Phase 4 (Custom Skills) — USER-AUTHORED guidance, and a completely separate
    # set of knobs from the three above. Sharing them would defeat the point:
    #
    #   * a SEPARATE budget is what stops a user's skill from evicting a built-in
    #     skill's constraints. `_pack` is score-ordered, and a user controls the
    #     text their own score is computed from, so one shared budget would make
    #     "write a skill that outranks the SEO skill" a way to drop its safety
    #     rules from the prompt. Two budgets means a user skill can only ever
    #     spend its own.
    #   * a SEPARATE min_score, because user skills are scored against a name the
    #     user chose rather than curated tags. Tuning their threshold must not
    #     move the built-in catalogue's precision, which was measured.
    #   * max_active 2, not 3: these compose ON TOP of whatever built-in skill
    #     activated, so the ceiling is what the two blocks cost together.
    #
    # OFF by default. Convex always sends the snapshot; this decides whether the
    # runtime reads it, so the whole feature can be enabled and disabled from one
    # place without a redeploy of the data plane.
    ai_user_skills_enabled: bool = False
    ai_user_skill_max_active: int = 2
    ai_user_skill_min_score: float = 0.25
    # 6000 = the built-in DEFAULT_SKILL_BUDGET_CHARS, not the 20000 the SEO skill
    # needed. A user skill's fields are capped at ~6.3k chars total by
    # skillPolicy.ts, so this carries roughly one whole maximal skill plus a
    # second smaller one — enough to be useful, small enough that the combined
    # prompt stays measured against the real context window.
    ai_user_skill_budget_chars: int = 6000
    # Phase 6 — resolve a skill's DECLARED capabilities through the intent map
    # before reserving them. ON by default, because the alternative is the bug:
    # `reserve_skill_tools` looked declarations up as literal tool ids, skills
    # declare intents, and the two namespaces are disjoint, so every declaration
    # was silently skipped.
    #
    # It has its own switch — separate from `ai_user_skills_enabled` — because
    # it changes BUILT-IN skill behaviour for every user, on the hottest path,
    # whether or not custom skills are on. seo-audit declares 8 intents and
    # blog-assist 10, each resolving to up to `limit_per` tools, and declared
    # tools sort to the FRONT of the schema-budget trim, so they can displace
    # what discovery found. That is the intended behaviour and it is why the
    # default is True — but a change of that size on a live deployment needs to
    # be revertible by a flag flip rather than by a redeploy.
    ai_skill_capability_resolution_enabled: bool = True
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
    # Humanizer — the INTERNAL final-writing stage (app/humanizer/stage.py),
    # adapted from blader/humanizer v3.0.0 (MIT). Run by CODE on writing
    # deliverables (router work type `produce` + a writing skill): the draft is
    # buffered, detected, rewritten on a stream only if it reads machine-written,
    # and verified (facts, figures, links, headings, labels) before it is kept.
    # OFF => every turn streams exactly as before.
    ai_humanizer_enabled: bool = False
    # Security audits (app/secaudit, adapted from openai/codex-security). A turn
    # the router classifies as a security AUDIT gets the audit skill, the read-only
    # security tools and a system-validated report; audits are read-only unless the
    # user explicitly asks for a fix (approval-gated). OFF => no security tools or
    # report (security queries still route to the complex model — that is the
    # router's rule, not this flag's).
    ai_security_enabled: bool = False
    # JSON {name: absolute path} of LOCAL git repositories the audit may read.
    # Empty (the default) = local repositories are unavailable to everyone.
    ai_security_local_roots: str = ""
    # Comma-separated authenticated user ids allowed to use those roots.
    ai_security_local_user_ids: str = ""
    # Per SARIF scanner wall-clock limit — well inside the 300s turn deadline
    # (measured: opengrep 11s, gitleaks 3s on the whole OllaSuper repository).
    ai_security_scanner_timeout_s: float = 120.0
    # Which SARIF scanners an audit runs (comma-separated). Only these are
    # attempted and reported; a configured scanner that is missing is
    # `not_installed`, never clean.
    ai_security_scanners: str = "opengrep,gitleaks"
    # Directory holding the pinned scanner binaries (deploy/65-secaudit.sh);
    # empty = PATH lookup only.
    ai_security_scanner_bin_dir: str = ""
    # OpenGrep/Semgrep ruleset; empty = the first-party app/secaudit/rules.
    ai_security_opengrep_rules: str = ""
    # Dependency audit: send lockfile package names/versions to api.osv.dev.
    ai_security_osv_enabled: bool = True
    # How long a model call may spend ESTABLISHING a connection, as distinct
    # from waiting for tokens. A generation legitimately takes minutes to
    # produce output; a TCP+TLS handshake to a healthy host takes under a
    # second. Sharing one budget between them means an UNREACHABLE provider
    # burns the whole generation deadline and the user gets a five-minute
    # spinner and then "the response took too long" — measured on production
    # 2026-09-16, when api.ollima.com stopped accepting connections. With a
    # short connect budget the call fails in seconds, the router learns the
    # model is down, and the user is told what actually happened.
    ai_model_connect_timeout_s: float = 10.0
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
    ai_default_model: str = "deepseek-v4-flash"
    # Model a CHAT turn is re-routed to when the selected model refuses for
    # capacity. Empty (the default) disables it and the runtime is unchanged.
    #
    # Mirrors ai_schedule_model_fallback, which exists because a provider 502 on
    # one model silently degraded every schedule parse. The same 502 has now taken
    # chat down twice via a HARDCODED default (an expired upstream credential,
    # then a weekly usage limit) — a constant is only right until the provider's
    # state changes, so this re-routes at run time. Deliberately ONE hop: a second
    # refusal is a real outage and must surface, not be papered over.
    ai_quota_fallback_model: str = ""
    # How long a capacity refusal is believed before the model is tried again.
    # Short enough that a recovered model returns without a restart; long enough
    # that a turn does not re-learn the same refusal on every step.
    ai_model_health_ttl_s: float = 600.0
    # Automatic model health (app/agent/health_probe.py). A background task in
    # this process re-checks models so a quota-limited model leaves rotation and a
    # recovered one returns without a restart or an .env edit. Cooldowns double
    # per consecutive failure up to `max_backoff_s`; a model with a real success
    # (traffic or probe) inside `revalidate_s` is not probed at all.
    ai_model_health_probe_enabled: bool = True
    ai_model_health_probe_interval_s: float = 60.0
    ai_model_health_revalidate_s: float = 1800.0
    ai_model_health_max_backoff_s: float = 3600.0
    # --- Master Model Router ------------------------------------------
    # OFF ships the whole mechanism with byte-identical behaviour: the runner
    # keeps using the model Convex chose. The flag is Python-side only, so it
    # CANNOT gate the frontend — which is why DEFAULT_MODEL in Convex was moved
    # to the fastest healthy model in the same release: with the picker gone,
    # router-OFF is the experience every user gets on rollback.
    ai_router_enabled: bool = False
    # JSON: {"<model-id>": {"ttft_s": 0.7, "tok_per_s": 122, "reasoning_tier": 0}}
    # Still config rather than a constant — re-measuring must never require a
    # deploy — but it now SHIPS WITH A DEFAULT instead of being empty. It lived
    # only in the VM's .env, where nothing could test it and it drifted out of
    # step with the catalogue unseen. Here, `test_routing` binds the shipped
    # profiles to the routing rules, so the two cannot diverge silently.
    #
    # THE THREE-TIER ROSTER. One model per reasoning class, and the tier→model
    # mapping is produced by the EXISTING rule in routing.select() — "the
    # cheapest model that meets the capability floor":
    #
    #   floor 0 (simple)   all three qualify      -> lowest ttft  -> gemini-3.7
    #   floor 1 (moderate) deepseek + gemini-3.8  -> lowest ttft  -> deepseek
    #   floor 2 (heavy)    only gemini-3.8        ->                 gemini-3.8
    #
    # That only works because the measured TTFT ordering matches the tier
    # ordering, which was checked rather than assumed (medians of 3 streamed
    # samples against the live endpoint, 2026-09-16):
    #
    #   gemini-3.7-flash-high  2.97s  [2.92 2.97 3.42]  529 tok/s
    #   deepseek-v4-flash      3.68s  [2.89 3.68 4.46]  159 tok/s
    #   gemini-3.8-flash-high  5.23s  [4.88 5.23 5.64]  571 tok/s
    #
    # The samples OVERLAP (deepseek's best beat gemini-3.7's median), so these
    # are medians, not guarantees. Routing reads these static numbers, which is
    # what makes the mapping deterministic per turn instead of a race.
    #
    # A catalogue model that is ABSENT here is emergency-only by construction:
    # select() falls back to ModelProfile() = ttft 99s, tier 0, so it loses
    # every comparison at floor 0 and is excluded at floors 1-2 — reachable only
    # when all three profiled models are filtered out as unhealthy.
    #
    # `vision` is the one capability the catalogue cannot supply: it reports
    # `vision: true` for every entry as a cosmetic default. deepseek-v4-flash is
    # marked false because production proved it — an image attachment routed
    # there and the provider answered 400 "this model does not support image
    # input", which reached the user as "Something went wrong". Absent = true, so
    # only a model KNOWN to refuse images is excluded from an image turn.
    ai_router_profiles: str = (
        '{"gemini-3.7-flash-high": {"ttft_s": 2.97, "tok_per_s": 529,'
        ' "reasoning_tier": 0, "vision": true},'
        ' "deepseek-v4-flash": {"ttft_s": 3.68, "tok_per_s": 159,'
        ' "reasoning_tier": 1, "vision": false},'
        ' "gemini-3.8-flash-high": {"ttft_s": 5.23, "tok_per_s": 571,'
        ' "reasoning_tier": 2, "vision": true}}'
    )
    # Estimated prompt+history tokens at or above which a turn routes to the
    # deepest reasoner instead of the fastest model.
    ai_router_heavy_tokens: int = 1200
    # A hard (non-capacity) provider failure is believed for longer than a quota
    # refusal: a model returning 502 because its upstream credential expired is
    # not going to recover in the 600s a weekly-quota reset might.
    ai_model_health_hard_ttl_s: float = 3600.0
    # How long a model is believed DOWN after we could not reach the provider at
    # all (connect refused/timed out, DNS gone). Deliberately short: unlike an
    # expired credential, a network outage recovers on its own, and believing it
    # for the hard TTL means the outage keeps costing users long after it ended.
    # One cheap re-probe a minute is the right trade.
    ai_model_health_unreachable_ttl_s: float = 60.0
    # The scheduling-intent parser's model, pinned SEPARATELY from the chat
    # default so a future change to chat cannot silently degrade parsing into
    # the fabricating manual-form fallback. Empty = follow ai_default_model.
    ai_schedule_model: str = ""
    # Tried when the primary parser model's provider fails. A 502 from the
    # upstream is what put every user into the raw-sentence fallback.
    # Empty disables the second attempt.
    #
    # Must not equal `ai_default_model`, which is what `schedule_model` falls back
    # to when `ai_schedule_model` is unset: both were "glm-5.2", so a box with no
    # explicit parser model had a "fallback" identical to its primary and
    # therefore no second attempt at all. `test_schedule_parse` guards it, and
    # caught exactly that collision again when ai_default_model moved onto
    # deepseek-v4-flash with the three-model router.
    #
    # Also a DIFFERENT FAMILY from the primary on purpose: the failure this
    # exists for is a provider-side fault, and a fallback sharing the primary's
    # upstream shares its outage.
    ai_schedule_model_fallback: str = "gemini-3.7-flash-high"
    # ONE extra model call, only when the parser came back with no usable
    # instruction — an empty `prompt`, or a `prompt` that is just the user's own
    # sentence echoed back. Without it the composer hands that failure to the
    # user as a blocked Create, which reads as "OllaSuper generated a task it
    # then refuses to save". Off = today's behaviour exactly (the echo guard
    # still blocks), so this is a kill switch, not a feature gate.
    ai_schedule_repair_enabled: bool = True
    # Title generation model — intentionally a tiny/fast model (Gemini Flash).
    # NOTE: gemini-2.0-flash-001 was RETIRED by OpenRouter (404 "No endpoints
    # found"); the live successor is gemini-2.5-flash-lite (multimodal, cheap).
    # The VM also sets AI_TITLE_MODEL, but this default must not be a landmine
    # on a fresh box.
    ai_title_model: str = "google/gemini-2.5-flash-lite"
    ai_max_output_tokens: int = 8192

    # Composer follow-up chips, produced out-of-band after a turn finalizes on
    # the title model (OpenRouter), so they cost none of the chat gateway's
    # quota. Off by default like every other capability flag here.
    ai_suggestions_enabled: bool = False

    # --- context -----------------------------------------------------------
    # 32k, not 1M. At Opus-5 input rates a full 32k context is ~$0.16/turn;
    # 1M would be $5.00 per message. A 32k window holds ~60 turns of ordinary
    # chat, far past the point where a rolling summary is the better tool.
    ai_context_budget_tokens: int = 32_000
    # Tokens reserved for the RESOLVED ARTIFACT pinned into the system prompt.
    #
    # It is pinned there rather than left in history because trim_messages
    # trims history OLDEST-FIRST, so the one message a follow-up is about is
    # the first thing evicted; the system prompt is a fixed cost that trimming
    # never touches. Counted into system_tokens, so budget_for still sees the
    # true remainder and the window cannot be overrun — this reserve DISPLACES
    # history rather than adding to it.
    ai_context_artifact_reserve_tokens: int = 6_000
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
    # Keep a BYTEA copy of each ingested file in the knowledge DB. The Convex blob
    # is the canonical original; this copy doubles storage and every backup. It
    # stays ON until libraryMigrations.restoreOriginals has verified every
    # Convex original (it is that migration's source), then goes OFF.
    ai_ingest_store_original_copy: bool = True
    # Disk the host must keep free for a GENERATED file to be stored (the edge
    # proxy refuses uploads below its own floor). Refused, never queued.
    ai_min_free_disk_bytes: int = 4 * 1024 * 1024 * 1024
    ai_disk_check_path: str = "/"
    # Data Analysis frames are cached per process. A deleted file's frame also
    # leaves on purge (routers/files.py); none outlives this.
    ai_data_cache_ttl_s: int = 600
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
    # Workbook WORK ceiling (audit F-04): logical cells/rows a spreadsheet may
    # make the decoder iterate, enforced as it runs in the sandbox child. Size
    # on disk bounds nothing — a 4.8 KB sheet can describe 12.8M cells.
    ai_xlsx_max_cells: int = 5_000_000
    ai_xlsx_max_rows: int = 1_048_576

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
    def mutation_url(self) -> str:
        return f"{self.convex_api_url.rstrip('/')}/api/mutation"

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

    # --- MCP server catalogue (Phase 2: DISCOVERY ONLY) ----------------------
    # A catalogue of what MCP servers EXIST. Nothing here connects to a server,
    # installs a package, or grants trust — those are Phases 3, 6 and 6.
    #
    # `/v0.1` (not `/v0`): both answer today, but v0.1 is the version the
    # registry's OpenAPI document describes and its README declares frozen.
    mcp_registry_base_url: str = "https://registry.modelcontextprotocol.io"
    # OFF by default. The catalogue is inert until an operator turns sync on, so
    # merely deploying this code contacts nobody.
    mcp_sync_enabled: bool = False
    # Hourly, and the INCREMENTAL path is what makes that defensible. A real
    # full sync measured 30,871 servers / 100,198 version records / 1,002 pages
    # in 360s -- six minutes of continuous sequential requests against someone
    # else's service, which hourly would be abusive. An earlier version of this
    # comment said "~2,600 records over 27 pages"; that number came from a shell
    # loop that mangled the cursor encoding and stopped early, and the design
    # consequence is the opposite of what it implied: incremental sync is
    # NECESSARY, not an optimisation.
    mcp_sync_cron: str = "0 * * * *"
    # The registry caps page size at 100.
    mcp_sync_page_size: int = 100
    mcp_sync_timeout_s: float = 30.0
    mcp_sync_max_retries: int = 4

    # --- Phase 3: remote MCP connections -------------------------------------
    # OFF by default. With this false the lifespan builds no pool, no route can
    # open a connection, and the deployment is byte-identical to Phase 2.
    mcp_connections_enabled: bool = False
    # TCP/TLS connect bound on the session's own httpx client.
    mcp_connect_timeout_s: float = 10.0
    # Bounds EVERY protocol request on a session -- initialize, tools/list and
    # each tool call. One knob rather than three because that is the only shape
    # the SDK offers: wrapping `enter_async_context(Client(...))` in an
    # `anyio.fail_after` raises "Attempted to exit a cancel scope that isn't the
    # current task's current cancel scope", since the timeout scope closes while
    # the Client's own task group is still open. Measured, not assumed.
    mcp_request_timeout_s: float = 30.0
    # The executor's per-tool `asyncio.wait_for` bound. Independent of the
    # above: it lives outside the SDK entirely.
    mcp_tool_timeout_s: float = 30.0
    # Session pool. Keyed on (user, workspace, connection) -- never on the
    # server alone, which is what makes cross-tenant reuse unreachable.
    mcp_session_idle_ttl_s: float = 300.0
    mcp_session_sweep_interval_s: float = 30.0
    mcp_max_sessions: int = 64
    mcp_max_sessions_per_user: int = 8
    # How long shutdown waits for sessions to close before cancelling. A parked
    # session never returns on its own, so without this a wedged remote server
    # could hold up systemd shutdown indefinitely.
    mcp_pool_close_timeout_s: float = 10.0
    # Bounds on what ONE remote server may push at us. A server decides how many
    # tools it advertises and how large their schemas are; the schema is walked
    # on every call AND sent to the model on every turn.
    mcp_max_tools_per_server: int = 256
    mcp_max_tool_schema_bytes: int = 64 * 1024
    mcp_result_max_bytes: int = 256 * 1024
    # ON THE WIRE, before any buffering (audit H-08). `mcp_result_max_bytes`
    # above bounds what reaches the model AFTER the SDK has read and parsed a
    # response in full; these bound what is READ at all. A JSON body larger
    # than the first, an SSE stream that keeps flowing past the second, or a
    # server-notification stream past the third is cut at the transport. Every
    # response must be uncompressed (`Accept-Encoding: identity`, and a
    # compressed one is refused), so wire bytes are decoded bytes.
    mcp_max_response_bytes: int = 8 * 1024 * 1024
    mcp_max_stream_bytes_per_request: int = 16 * 1024 * 1024
    mcp_max_listen_stream_bytes: int = 64 * 1024 * 1024
    # Content blocks per tool result, and nesting depth of structured content,
    # both applied BEFORE anything is serialised for the model.
    mcp_max_result_blocks: int = 512
    mcp_max_result_depth: int = 32
    # Tool-call quotas (audit H-09; `app/mcp/quota.py`). Per TURN: total calls,
    # calls per connector, calls per tool, identical calls, result bytes. Per
    # USER: calls in flight at once (process-wide). The hourly per-user cap is
    # Convex's (`mcp/limits.ts`, kind `mcpToolCall`).
    mcp_max_calls_per_turn: int = 64
    mcp_max_calls_per_connection_turn: int = 24
    mcp_max_calls_per_tool_turn: int = 8
    mcp_max_identical_calls_turn: int = 2
    mcp_max_result_bytes_per_turn: int = 2 * 1024 * 1024
    mcp_max_concurrent_calls_per_user: int = 4
    # Static test credentials from the environment (`mcp_test_credentials`)
    # are a DEVELOPMENT convenience: they hold a real third-party secret in a
    # process env var, in the unit file and in `systemctl show`. They are
    # refused unless this is set (audit M-08); production runs the vault.
    mcp_allow_env_credentials: bool = False
    # Phase 5: the same reasoning, for the two capability kinds that are not
    # tools. A resource body and a rendered prompt both land in the context
    # window, so each needs its own ceiling; the executor's `result_max_chars`
    # then bounds what actually reaches the model.
    mcp_resource_max_bytes: int = 128 * 1024
    mcp_prompt_max_chars: int = 32 * 1024
    mcp_max_resources_per_server: int = 256
    mcp_max_resource_templates_per_server: int = 64
    mcp_max_prompts_per_server: int = 128

    # --- Phase 6: local execution via the Docker MCP Gateway -----------------
    # OFF. With this false the turn is byte-identical to Phase 5: no local row is
    # read, no gateway is dialled, and `endpoint_trust` never leaves its default.
    mcp_local_enabled: bool = False
    # The gateway is operator-run infrastructure, addressed like
    # `convex_internal_url` rather than like a catalogued server. It MUST be
    # loopback — `assert_gateway_url` refuses anything else, because a remote
    # gateway would put the auth token below on a network.
    mcp_gateway_url: str = "http://127.0.0.1:8811"
    # The bearer the bridge (`bridge/mcp_bridge.py`) requires on every request
    # and the resolver sends for gateway-trust endpoints (audit N-06: it used to
    # be configured and sent by nobody). Registered in `secrets()` so the log
    # redactor scrubs it.
    mcp_gateway_auth_token: str = ""
    # Where `bridge/mcp_bridge.py` writes runtime attestations (root-owned);
    # `resolve_local_spec` refuses a local server without a verified one. Empty
    # = the fixed system path; tests point it at a temp dir.
    mcp_local_attestation_dir: str = ""
    # Ceilings a curated row may ask UNDER, never over.
    mcp_local_max_cpus: float = 2.0
    mcp_local_max_memory_mb: int = 2048
    # THE UNSAFE DEVELOPMENT FLAG (§52). It permits a `test`-trust row to start
    # and NOTHING else: a blocked row, an unpinned image or a denied environment
    # variable is still refused. Never true in a deployment; `main.py` refuses to
    # start if it is set alongside a non-loopback gateway.
    mcp_local_allow_untrusted: bool = False
    # DEVELOPMENT/TEST ONLY. `{"slug": "token"}` or `slug=token,slug2=token2`.
    # Registered in `secrets()` below so the log-redaction filter scrubs it.
    # Phase 4's vault replaces this; it is not a credential store.
    mcp_test_credentials: str = ""

    # --- Phase 4: OAuth + the encrypted credential vault ---------------------
    # OFF by default. With this false no credential is read or written, no
    # OAuth route can start a flow, and the deployment is byte-identical to
    # Phase 3.
    mcp_oauth_enabled: bool = False
    # Master key material: {"1": "<base64 32+ bytes>", "2": "..."}.
    # NEVER generated and NEVER defaulted — a boot-time key would encrypt
    # credentials no later process could read, and a hardcoded one would be no
    # encryption at all. The service refuses credential operations when this is
    # unset while the flag above is on. Operator-written into services/ai/.env
    # (0600), exactly like OPENROUTER_API_KEY.
    mcp_credential_keys: str = ""
    mcp_credential_active_key_version: int = 1
    # The ONE registered OAuth redirect. Exact match, no wildcards, never
    # user-supplied. A Convex HTTP route because it has no locale prefix — the
    # Next.js app is `[locale]`-segmented, so an app path would bake in "en".
    mcp_oauth_redirect_uri: str = "http://127.0.0.1:3211/mcp/oauth/callback"
    # Client ID Metadata Document URL. WIRED BUT UNSET: CIMD needs a publicly
    # reachable HTTPS document and this phase does not expose the service, so
    # leaving it empty falls through to dynamic client registration. A
    # placeholder here would be a lie told to every authorization server.
    mcp_oauth_client_metadata_url: str = ""
    # How long a pending authorization stays claimable. A human clicking through
    # a consent screen with a second factor and an "unverified app" warning in
    # the way — two minutes was measured too short on production. Ten matches
    # the providers' own authorization-code validity. See oauth/attempts.py.
    mcp_oauth_attempt_ttl_s: float = 600.0
    # Per-server scope allowlist, e.g. {"github": ["repo:read"]}. EMPTY BY
    # DEFAULT, which means "request what the server's metadata asks for" — the
    # specification's behaviour. Narrowing is applied to the authorization URL
    # because the SDK overwrites `client_metadata.scope` from server metadata,
    # so configuring a narrower scope does nothing. See oauth/flow.py.
    mcp_oauth_scope_allowlist: str = ""

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
                # Development MCP tokens. They are attached as Authorization
                # headers to a third party, so they are exactly the kind of
                # value a stack trace or a debug log would otherwise carry.
                self.mcp_test_credentials,
                # THE master key for every stored credential. If this ever
                # reached a log line, the encryption would be decorative.
                self.mcp_credential_keys,
                # Phase 6: the gateway's localhost auth token. A bearer header
                # on every gateway request, so it must be scrubbed like any
                # other credential.
                self.mcp_gateway_auth_token,
            )
            if s
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
