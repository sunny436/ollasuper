# Phase 0 — OllaSuper SEO: Verified Codebase & Production Truth

**Status:** Phase 0 complete (baseline only — no SEO Skill/Agent built, no runtime/architecture change).
**Date:** 2026-08-26. **Method:** 3 parallel code sweeps + direct file reads + live prod inspection
(VM 172.16.70.25) + hermetic test runs. Citations are `path:line`. No secret values were read or printed.

> Purpose: establish the exact truth the later SEO phases build on, and confirm/refute every blocker
> the Codex plan asserted — against the ACTUAL implementation, not documentation.

---

## 1. Live runtime path (the path later phases must preserve)
Entry `POST /v1/generate` (202, detached task, `routers/generate.py:28-62`) →
**`runtime/runner.py:run_generation`** (streaming), **NOT** `Orchestrator.run()` (batch-only,
"not yet wired to the live path" — `runtime/roster.py:160-162`).

```
USER (runner.py:139) → context/RAG prep (147-254) → system prompt (268) → LLM build (279-299)
 → TOOL BIND (324-433): web_active requires agent_enabled AND tool_registry.count>0;
   tool_selector.select → build_tool_specs → llm_for_tools.bind_tools
 → ORCHESTRATED BLOCK (flag-gated, 492-557): find_capabilities + skills + delegate_to_agent
 → GRAPH (agent/graph.py:211-223): START→prepare→model⇄executor→END
 → TOOL EXEC (agent/executor.py): find_capabilities(1240) / delegate_to_agent(1316) / request_clarification(1359)
 → STREAM (runner.py:740-777): only langgraph_node=="model" chunks reach the user
 → writer.finalize
```
The `Orchestrator` is built (`build_live_runtime`, roster.py:156) only to lend `make_delegator`
+ the skill registry; it never runs its own graph on a live turn. A delegated sub-agent runs
**batch** and its text returns as a tool observation the top model synthesizes into the stream.

## 2. Production truth (VM 172.16.70.25 — live now)
- `myos-ai` + `myos-app` **active**. `myos-ai` = systemd `myos-ai.service`, WorkingDir
  `/opt/myos/services/ai`, `127.0.0.1:8770`, uvicorn `--workers 1` (in-process cancel registry),
  `openapi_url=None` (docs off in prod → `/openapi.json` empty; code is the route source of truth).
- **Flags ON in prod `.env`** (mtime 2026-08-26 15:15, recent): `AI_ORCHESTRATED_RUNTIME_ENABLED`,
  `AI_AGENT_ENABLED`, `AI_AGENT_SIDE_EFFECT_ENABLED`, `AI_AGENT_RAG_TOOL_ENABLED`,
  `AI_AGENT_MEMORY_TOOL_ENABLED`, `AI_FILE_GENERATION_ENABLED` = `true`.
  `OLLAGRAPH_BASE_URL` (len 25) + `OLLAGRAPH_API_KEY` (len 52) set → `agent_enabled = TRUE`.
  `KNOWLEDGE_DATABASE_URL` (len 115) set → RAG live. Chat generation on Ollima (`OLLIMA_*` set).
  → **The full orchestrated agent runtime (tools + skills + delegation + RAG + memory + file-gen)
  is LIVE in production, not dormant.** (The populated 147-tool registry proves discovery actually ran.)
- **Live tool registry** `GET /v1/tools` (service-key gated, metadata-only) → snapshot committed at
  `seo/research/tool-registry-snapshot.json`: **147 tools, all `provider: ollagraph`.**
  side_effect split: **read_only 77 · external_side_effect 34 · high_impact 36**. Categories:
  Intelligence 36, Account 21, Actors 15, Other 12, AEO 10, SEO 9, Authentication 8, Conversion 7,
  Billing 7, Scraping 6, Extraction 5, Automation 4, Parsing 3, Captcha 2, Jobs 1, Crawling 1.

### KEY REFRAME — Ollagraph IS the SEO/scrape/intel provider
`seo_endpoint.txt` (relocated to `seo/research/ollagraph-endpoints.txt`) is Ollagraph's endpoint
catalogue, and those endpoints are **already discovered, bound, and executable as tools**
(`seo_*`, `aeo_*`, `scrape_*`, `extract_*`, `crawl`, `intel/*`). The Codex `seo.native.*` raw-tool
build is **largely already satisfied at the tool layer.** The real gaps are the higher layer:
SEO skill/agent, evidence/finding contracts, GSC/GA4/PSI/CrUX connectors, durable runs.

**Epistemic caveat (per the Codex plan itself):** these are a provider's endpoints — "validated for
workflow correctness, never proven SEO outcomes." Ollagraph is **not** GSC/GA4/PSI/CrUX (first-party
OAuth connectors still to build), and no evidence-class / causal-status labeling exists on tool
outputs yet. So the SEO work over these tools is an **intent allowlist + evidence/finding contracts**,
not more raw tools.

## 3. Blockers — Codex claims vs actual code (every one personally verified)
Orchestration (`services/ai/app/…`):

| # | Blocker | Verdict | Evidence |
|---|---|---|---|
|1|Skill/delegation only after tools bound (knowledge-only Q won't activate a skill if no specs)|**CONFIRMED**|`runner.py:492` block nested in `if llm_tools is not None`(445) in `if specs`(431). Nuance: specs can also come from RAG/memory/filegen, not only Ollagraph.|
|2|Agent readiness ≡ Ollagraph readiness|**CONFIRMED (one-way gate)**|`config.py:408` `agent_enabled = ai_agent_enabled AND ollagraph_enabled AND ollagraph_api_key`.|
|3|Live runner re-discovers skills vs `Orchestrator._prepare_run` (dup prep)|**CONFIRMED**|`runner.py:511` vs `orchestrator.py:164`; `roster.py:161`.|
|4|Live prep ignores `SkillManifest.preferred_capabilities`|**CONFIRMED**|runner reads only `require_approval`(528); only `orchestrator.py:189` reads it (off live path). All 4 prod skills leave it `frozenset()`.|
|5|`request_clarification` in `Agent.build_context` but not bound by live runner|**CONFIRMED**|`base.py:175-177` CLARIFY spec; runner binds only `FIND_CAPABILITIES`(498)+`delegate`(543).|
|6|Delegated agents lose approvals/budget/RAG/memory/resume|**CONFIRMED**|`runner.py:545-556` delegator AgentEnv omits `approvals/fit_budget/rag/memory/resume/attempt`; `orchestrator.py:330-335` `replace(env,…)` faithfully copies those empties. `base.py:210-220` would use them if present.|
|7|Delegation returns unbounded text, drops structured data/errors/metrics|**CONFIRMED**|`orchestrator.py:337-341` → `{ok,outcome,text}`; `executor.py:1352-1356`. Drops `AgentResult.data/requested_capability/error/metrics`.|
|8|Nested agents can collide step IDs (incomplete lineage)|**CONFIRMED**|`executor.py:345-349` `step_id=run_id:a{attempt}:s{counter}`; sub-agent reuses parent `run_id`(base.py:215), `attempt=0`, counter restarts → sibling/nested subs all `a0:s…` collide. No agent_id/delegation_id/parent_execution_id.|
|9|`Agent._finalize` parses JSON but doesn't validate `OutputContract.schema`; `expects` unused|**CONFIRMED**|`base.py:335-341` → `_try_parse` = bare `json.loads`(379-387), no schema check; `OutputContract.expects`(spec.py:91) has zero refs.|
|10|One deadline, begins before final streaming not before prep/delegation|**PARTIAL**|Deadline VALUE anchors at `started`/`deadlineAt` (covers prep, runner.py:714-719); active GUARD (heartbeat) arms at `runner.py:731` right before `astream` → **prep-time hang unguarded**. Delegation IS under the guard (runs inside astream).|
|11|Usage not aggregated across specialist+synthesis+tools+providers|**CONFIRMED**|`runner.py:744,754-758` sums only top-graph `model` chunks; sub-agent tokens stranded in `AgentResult.metrics` (dropped by #7); tool/provider tokens never added.|

Tool/skill/adapter — **all 6 CONFIRMED**:
1. registry only created when `ollagraph_enabled` (`main.py:89-91`).
2. `replace_all` rebuilds the whole registry from the passed tools with **no provider partitioning**
   (`tools/registry.py:44-65`) → a second provider's tools would be wiped.
3. flat `_components` schema namespace, overwritten wholesale (`registry.py:19,61-62`) →
   cross-provider schema-name collisions.
4. executor calls `OllagraphAdapter` **directly**; `tool.provider` never used to dispatch
   (`executor.py:52,802-813`, `runner.py:396`).
5. metadata is provider-neutral (`models/tools.py`) but execution is Ollagraph-coupled
   (`clients/ollagraph.py`).
6. only a global `Availability` (always AVAILABLE), single global key, **no per-user
   credential/property/quota readiness and no `CapabilityGap` type**.

**Types the Codex plan proposes do NOT exist yet** (these are the Phase-1 seams): `PreparedRun`
(today a bare tuple, `orchestrator.py:164-200`), an `AgentEnv` factory (hand-built + `dataclasses.replace`),
`AgentHandoff` (delegation downgrades `AgentResult`/`OrchestratorResult` to a plain dict).

**Routing:** there is **no second routing model** (grep of `runner.py` clean). The live path binds
tools and lets the **constrained model** choose direct-answer / `find_capabilities` / `delegate` via
tool-calling — i.e. the Codex "don't add a second router by default" is already the state.

## 4. Convex / frontend / durable-run readiness
- **Chat finalize folds/deletes** (`chat/ingest.ts:346-456`): `chatStreamChunks` + `toolExecutions`
  DELETED; `chatStreamEvents` folded into `chatMessages.events` then deleted. `chatArtifacts` is the
  deliberate **persistent** exception (downloads survive the turn).
- **~5-min total deadline**: `AGENT_TOTAL_DEADLINE_MS = 300_000` (`chat/messages.ts:28,293`); reaper
  fails (not resumes) past `deadlineAt` (`chat/stream.ts:697-703`, cron 60s). Python mirror
  `ai_agent_total_deadline_s=300.0`. → **durable SEO runs need a SEPARATE worker/writer + tables**,
  not chatStreams.
- **Artifact protocol = the ready, secure SEO run-card seam**: binary POST `/ai/artifact`
  (ingress-gated, streamId-scoped, owner derived server-side, 30 MB cap, `http.ts:557-587`) →
  `chatArtifacts`. Download: `ARTIFACT` event carries **`artifact_id` only** → authenticated
  `mintDownload` (owner-checked, 5-min token) → `/artifact/file`. **No storageId/bearer URL ever
  leaves the server.** An `seo_run` plugs in as a new `artifact_type` (no schema change) or a new
  event type (3 mirrored places: `convex/chat/events.ts` EVENT_TYPES, `services/ai/app/models/events.py`,
  `apps/app/.../chat/_lib/agent-events.ts` + a render branch).
- **No `seo*` tables exist** (schema.ts, grep clean). `anyApi` makes new Convex modules
  runtime-callable immediately; `_generated/api.d.ts` needs `convex dev` codegen for type-visibility.

## 5. Risks
- 🔴 **[SECURITY, pre-existing, HIGH] Real Convex deploy key in git history.** `convex.txt` held a
  genuine deploy key — a `name|token` line with a **56-char token** + 2 Convex URLs — committed
  `6f766c4` (2026-08-17), untracked same-day `48e4bbc`, **still in `origin/main` history on GitHub**
  (repo is **PRIVATE** → exposure = collaborators + clones, not public). No `.env` or other cred file
  was ever committed (all 0 commits). **→ rotate the Convex deploy key** (see `seo/CREDENTIAL-ROTATION.md`).
- 🔴 **[SECURITY] High-impact provider tools in the live registry.** 36 `high_impact` tools =
  **Account 21 + Billing 7 + Authentication 8** on the *shared Ollagraph service account*
  (`delete_my_account`, `change_my_password`, `rotate_my_key`, `create_my_key`, billing mutations).
  The SEO agent MUST be hard-scoped by a read-only **intent allowlist** (77 read_only + selected
  external_side_effect SEO/scrape tools) and can never reach these.
- 🟡 **[HYGIENE] `seo_endpoint.txt` was untracked AND un-ignored** (a `git add -A` would stage it).
  Relocated into `seo/research/ollagraph-endpoints.txt` (holds no secrets).
- 🟡 **[CORRECTNESS] Lossy delegation + no schema validation + prep-deadline gap** (blockers 6–11)
  are latent today (text synthesis masks the structured loss); they become correctness-critical once
  the SEO agent returns typed findings/evidence.

## 6. Baseline test results (hermetic, run 2026-08-26, no prod)
- **`services/ai` pytest: 474 passed, 11 skipped, 0 failed** (skips = DB-backed tests that self-skip
  without `TEST_DATABASE_URL`). GREEN.
- **`packages/backend` convex-test: 195 passed, 2 failed, 1 skipped (198).** The 2 failures are **5s
  `testTimeout` timeouts under full-suite load** in `chat.security.test.ts` → "/ai/file is
  capability-scoped" (attachment-blob tests) — NOT assertion failures; **re-run in isolation they pass
  in 2.2s** → environment/contention flakiness on the dev box, not a defect. CI (typecheck→lint→test,
  gates every PR) is the authoritative green. *Candidate hygiene tweak for a later phase: raise that
  suite's `testTimeout` — these same tests exercise the blob-storage path SEO artifacts will use.*
- typecheck 7/7, lint green (sherif clean). No test was modified to pass.
- e2e (`e2e/*.js`, 33 scripts) require a live deployment — the interactive baseline, run selectively.

## 7. Phase-0 close-out
- **Changes made:** additive docs only under `seo/` (this report, `README.md`,
  `tool-registry-snapshot.json`, `provider-lifecycle.md`, `CREDENTIAL-ROTATION.md`,
  `evals/fixtures/baseline-corpus.md`); relocated `seo_endpoint.txt` → `seo/research/ollagraph-endpoints.txt`.
  **Zero runtime/architecture/schema/test changes.**
- **Tests executed:** pytest (474/0-fail), convex-test (195 + 2 env-flaky + 1 skip), typecheck/lint.
- **Failures:** only the 2 environment-timeout convex tests (pass in isolation); no product failures.
- **Remaining blockers:** the verified §3 table — all real, all Phase-1 targets. Plus the deploy-key
  rotation (owner action).
- **Phase-1 handoff:** build `Orchestrator.prepare` (+`PreparedRun`), a single `build_live_agent_env`
  factory (top-level AND delegated — restoring approvals/RAG/memory/resume/budget), an adapter
  registry keyed by `tool.provider` (+`replace_provider`, provider-scoped schema components), a bounded
  Pydantic `AgentHandoff`, real `OutputContract.schema` validation (≤1 repair), and execution lineage
  (agent_id/delegation_id/parent_execution_id/stable step_key). Behind flags; existing chat
  **byte-identical with SEO off**; **no second router**. SEO tool access = an **intent allowlist** over
  the existing 147 Ollagraph tools (read-only SEO/scrape/extract/crawl), never the 36 high_impact ones.
