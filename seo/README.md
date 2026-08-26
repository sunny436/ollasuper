# OllaSuper SEO — implementation packet

This directory is the **planning/handoff packet** for the OllaSuper SEO system (docs, research,
schemas, evals, decisions) — **not** executable code. Executable implementation lands under the
existing architecture when its phase arrives:

- `services/ai/app/seo/` + `services/ai/tests/seo/` (Python inference plane)
- `packages/backend/convex/seo/` (Convex data plane)
- `apps/app/src/app/[locale]/(workspace)/chat/_components/seo/` (frontend)

## Sequencing (from the Codex plan)
Fix the live orchestration + provider boundary **first**, prove read-only chat **second**, then add
artifacts, connectors, durable jobs, monitoring, and only finally mutations.

## Status
| Phase | State |
|---|---|
| **0 — Production & codebase truth (baseline)** | ✅ complete — see [`research/phase-0-baseline.md`](research/phase-0-baseline.md) |
| 1 — Runtime correctness (prepare/env-factory/adapter-registry/handoff/schema/lineage) | ⏳ not started |
| 2+ — read-only chat MVP, reports, connectors, durable runs, monitoring, writes | ⏳ not started |

## Contents
- `research/phase-0-baseline.md` — the verified Phase 0 report (runtime path, blockers, prod truth, risks, tests).
- `research/tool-registry-snapshot.json` — the live `/v1/tools` dump (147 Ollagraph tools, metadata only).
- `research/ollagraph-endpoints.txt` — Ollagraph's SEO/scrape/intel endpoint catalogue (was `seo_endpoint.txt`).
- `research/provider-lifecycle.md` — data-source/provider status matrix (stub, for later phases).
- `evals/fixtures/baseline-corpus.md` — the frozen 10-class baseline eval corpus.
- `CREDENTIAL-ROTATION.md` — the one security remediation Phase 0 surfaced (owner action).

## The one thing to do before Phase 1
Rotate the Convex deploy key — see `CREDENTIAL-ROTATION.md`.
