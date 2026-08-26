# Frozen baseline eval corpus (Phase 0)

Ten classes of the **current** (pre-SEO) runtime, frozen so later phases can prove they did not
regress existing chat/agent behavior when SEO is added. Phase 0 asserts **no SEO** — this only pins
the current routing/behavior. `expected_route` is derived from the verified runtime
(`../../research/phase-0-baseline.md` §1/§3); the **observed** route should be recorded by running each
prompt against a live deployment (an interactive/CI step in a later phase), not asserted here.

Frozen inputs — do not edit prompts once a later phase measures against them; add new cases instead.

| id | class | prompt | expected_route (current runtime) | what it baselines |
|---|---|---|---|---|
| B01 | simple chat | `Hi! Can you introduce yourself in one sentence?` | direct model answer; no tools, no skills; streams | plain chat unchanged |
| B02 | direct single-tool call | `Fetch https://example.com and tell me its <title> and meta description.` | model calls ONE read_only Ollagraph tool (scrape/meta), then streams synthesis | single bounded tool use |
| B03 | no-tool knowledge question | `What is a canonical tag and when should I use one?` | direct model answer; may activate a skill (guidance) but calls no tool | knowledge answer w/o tools |
| B04 | capability discovery | `What can you do to analyze a website's technical SEO?` | model may call `find_capabilities` (flag-gated) to surface tools, then answers | discovery path (runner.py:492-501) |
| B05 | delegation | `Do a thorough multi-source diagnosis of why https://example.com might be losing organic traffic, and synthesize findings.` | model calls `delegate_to_agent` (flag-gated); sub-agent runs batch; text synthesized into stream | delegation seam (blockers 6-8,11 live here) |
| B06 | approval (side-effect) | `Run an async crawl of https://example.com` (an `external_side_effect` tool) | tool parks → `waiting_approval`; on approve, resumes and completes | approval gate + fresh deadline |
| B07 | tool failure | `Fetch https://this-domain-does-not-resolve-zzz.invalid and summarize it.` | tool returns error ToolMessage; model recovers/reports failure honestly | error handling, no crash |
| B08 | provider unavailable | (same as B02) evaluated with Ollagraph disabled/empty | `web_active` false → no tools bound → plain chat path (no skills/delegation) | graceful degrade (config gate) |
| B09 | streaming | `Write a 150-word explanation of Core Web Vitals.` | model tokens stream mid-generation (langgraph_node=="model" chunks) | streaming transport intact |
| B10 | resume | a generation whose stream stalls > STALL_MS | reaper re-queues (≤ MAX_RESUME_ATTEMPTS); completed tool calls deduped via seen_calls; fails at `deadlineAt` | durable resume/dedup (chat.durable.test.ts) |

## Invariants every case must still satisfy after SEO is added (flag ON or OFF)
- **Flag OFF → byte-identical** to today's runner (the Phase-13 guarantee).
- Zero console errors in the browser (the e2e gate); `threadId` from a URL never reaches a `v.id()` validator.
- No `high_impact` Ollagraph tool (the 36 Account/Billing/Auth tools) is ever offered to or invoked by
  the SEO agent — read-only intent allowlist only.
- Authorization: chat stays user-scoped (not workspace); no cross-user artifact/stream access.
