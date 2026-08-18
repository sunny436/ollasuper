# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**myos** — a self-hosted, multi-tenant SaaS control-plane forked from `get-convex/v1`, plus an AI chat product built on top of it. It is **live in production** on a VM at `10.1.30.14` (Convex `:3210`/`:3211`, Next `:3000`, backend-echo `:4000`, dashboard `:6791`), publicly tunnelled at `app.ollasuper.com` — with Convex reachable at `convex.ollasuper.com` (`:3210`) and `convex-site.ollasuper.com` (`:3211`), because the browser opens its WebSocket to Convex directly and cannot ride on the app's hostname. Treat pushes to it accordingly.

`ollasuper.com` itself is **not ours** — the apex, `www` and `tokens.` serve other properties (a marketing site and a design-token site on Cloudflare Pages), and the zone carries live MX/SPF/DKIM/DMARC mail records. Anything touching DNS must operate on an allowlist of our three hostnames; `deploy/58-ollasuper-dns.sh` does, and diffs the whole zone afterwards to prove nothing else moved.

`TEMPLATE.md` describes the original seam: the control-plane is the platform plumbing (auth, orgs, files, billing), and "your product/AI logic lives in a separate backend." The AI half is now built — see **Two planes** below.

The dashboard, devices, sessions, AI-access, jobs and platform sections were removed; `/` redirects to `/chat`. The remaining surfaces are **Chat**, **Files**, **Settings** and **Billing**. Tenancy, RBAC, API keys, usage, audit and events survived the removal as backend-only modules — they lost their Platform UI, not their function.

## Where the data lives (changed 2026-08-18)

**Convex Cloud (`benevolent-koala-651`) is the source of truth for ALL Convex
data**, including users, accounts, sessions, workspaces, members and chat. The
self-hosted Convex on the VM is retained only as a rollback snapshot.

`users` could not be moved on its own: `Id<T>` is deployment-scoped, 16
`v.id("users")` foreign keys span the schema, `upsertUserAndAccount` writes
`users`+`authAccounts` in one transaction, and `getAuthUserId` is a bare cast on
the JWT `sub` with no DB lookup — so a split fails *silently*, not loudly. The
whole deployment therefore moved together.

- The app selects its deployment purely through **`NEXT_PUBLIC_CONVEX_URL`** in
  `/opt/myos/apps/app/.env`. It is **build-time**: changing it needs
  `rm -rf .next` + a full rebuild; a service restart alone does nothing.
- **Rollback:** restore `/opt/myos/apps/app/.env.pre-cloud`, rebuild, restart,
  and `docker compose up -d` in `self-hosted/` if it was stopped. The
  pre-migration snapshot is pinned at `/opt/backups/PRE-CLOUD-MIGRATION.zip`.
- **`packages/backend/.env.local` takes precedence over `CONVEX_DEPLOY_KEY`.**
  Any CLI command meant for Cloud must pass `--env-file` at an empty file, or it
  silently acts on self-hosted instead. Verify by reading the value back.
- The Cloud **deploy key** lives at `/root/.cvx-cloud-key` (0600) on the VM,
  mirroring how the self-hosted admin key lives in `packages/backend/.env.local`.
  It is needed for `convex deploy`/`env`/`logs`, never by the running app.
  `/root/cloud-logs.sh` wraps `convex logs` with a timeout so e2e can read auth
  codes (`convex logs` streams forever and would hang a blocking exec).
- On Cloud, `CONVEX_SITE_URL` is **injected** — never set it. `SMTP_*` and
  `AI_BASE_URL` are deliberately **not** carried: both point at private
  addresses Cloud cannot reach.
- Because no mail transport is configured on Cloud, `authCodes.deliverCode`
  falls back to **logging** OTP/verification/reset codes. That is an
  authentication-bypass risk for anyone with log access: set `RESEND_API_KEY`
  before real users depend on it.

## Commands

Bun workspaces + Turborepo. Run from the repo root unless noted.

```bash
bun install                 # bun 1.3.14 in CI; bun.lock is the text lockfile (never bun.lockb)
bun run typecheck           # turbo typecheck  — tsc --noEmit per workspace
bun run lint                # turbo lint + sherif (monorepo dep consistency)
bun run test                # turbo test — currently only @v1/backend has tests
bun run build               # turbo build
bun run dev:app             # Next dev server for apps/app
```

CI (`.github/workflows/ci.yml`) runs exactly typecheck → lint → test on every PR.

### Convex backend (`packages/backend`)

```bash
cd packages/backend
bun run test                              # vitest + convex-test, runs the whole backend in-process
bunx vitest run convex/chat.security.test.ts          # one file
bunx vitest run -t "cannot claim-squat"               # one test by name
bun run dev                               # convex dev --tail-logs (needs .env.local admin key)
```

`convex-test` runs on `@edge-runtime/vm`, so authorization, schema, ingress idempotency and the streaming state machine are all verifiable **with no deployment and no network**. Prefer it to manual testing.

### Python inference plane (`services/ai`)

```bash
cd services/ai
uv sync
uv run pytest                             # 35 tests, no network / no Convex / no API key needed
uv run pytest tests/test_writer.py -k batching
uv run ruff check .
uv run uvicorn app.main:app --port 8770   # dev
```

`uv` provisions its own CPython 3.12 — a system Python is not required and is not used.

### e2e (`e2e/`, plain Playwright scripts, no framework)

Run **against a deployed stack**, not locally:

```bash
cd e2e && bun install
node p-chat.js              # or: bun run chat
node p-chat-isolation.js    # cross-user isolation — covers what convex-test cannot
```

Every script asserts **zero console errors**. That gate is load-bearing: a `console.error` from a rejected Convex call fails the suite, which is why `threadId` from a URL must never reach a `v.id()` validator (see below).

### Build gotcha

`bun run build` fails at `@v1/app` with `Invalid environment variables: NEXT_PUBLIC_CONVEX_URL` unless that var is set. It is public, not a secret:

```bash
cd apps/app && NEXT_PUBLIC_CONVEX_URL=http://10.1.30.14:3210 bun run build
```

## Architecture

### Two planes

```
Browser ─▶ Next.js (apps/app)  ──useQuery/useMutation over WebSocket──┐
                                                                      ▼
                        CONVEX — data plane (TypeScript, packages/backend)
                        auth · orgs/RBAC · files · usage · audit
                        chatThreads/Messages/Streams/StreamChunks/…
                            │ action → POST /v1/generate      ▲ POST /ai/ingress
                            ▼   x-service-key                 │   x-ai-key + streamId
                        PYTHON — inference plane (services/ai, 127.0.0.1:8770)
                        FastAPI + LangGraph → OpenRouter → Claude
```

Convex owns persistence, auth and reactive transport. **Python owns every line of AI logic** — Convex has no Python runtime, so this split is what makes the repo-wide Python-first policy workable. `backend-echo/` is a separate, still-live reference backend on `:4000`; the inference plane does not replace it.

### Streaming is Convex-mediated

The browser never talks to Python. Python POSTs token batches to `/ai/ingress`; the browser's `useQuery` subscription re-renders. That is what makes a stream survive a refresh, work in a second tab, and need no SSE on the client.

The design turns on one fact: **Convex re-sends the whole query result to every subscriber on any write, with no document-level diffing.** Therefore:

- The in-flight assistant row is written **exactly twice** — `""` on insert, final text on finalize. It is never patched during streaming. `chat.messages.listPaged` excludes in-flight rows and stays stable during a generation.
- Deltas are append-only rows in `chatStreamChunks`, compacted into `chatStreams.committedText` every 24 seqs.
- `chat.stream.active` is the **only** query that re-fires during a generation. It returns one small document.
- `chatStreams` is a separate table from `chatMessages` because it is patched per delta, and `chatMessages` carries a full-text search index that would be rewritten every token.

If you add a field to `chatMessages` that changes during a stream, you have undone this.

### Cancellation rides the ingress response

Convex cannot push to Python. `chat.stream.stop` finalizes the message immediately (the UI must stop when the user asks, whatever Python is doing) and sets `cancelRequested`. Every `/ai/ingress` response carries `{cancel}`, so Python learns within one flush (≤700ms) with no polling. This is worker-agnostic — the authority is a Convex field, not process memory.

### Authorization

Two different trust models coexist. Getting them confused is the main hazard in this codebase.

| Surface | Trust boundary | Helper |
|---|---|---|
| files, audit, events, members | **workspace** — any member reads any row | `requireMember` / `requireRole` (`convex/orgs.ts`) |
| **chat** | **user** — `workspaceId` is for tenancy/billing only | `convex/chat/authz.ts` |

`convex/chat/authz.ts` is a separate file to avoid an import cycle with `orgs.ts` (same reason `auditLog.ts` was split out). Every non-owner gets `"Not found"`, never `"Forbidden"` — the error must not be an existence oracle for someone else's `threadId`.

There is **deliberately no workspace-only index** on `chatThreads`/`chatMessages`. With none, no query shape in this codebase can enumerate a tenant's conversations without pinning a `userId` first. Do not add one.

`userId` always comes from `getAuthUserId(ctx)`, never from args.

### Capability scoping, not just secret gating

`AI_INGRESS_SECRET` alone is not enough to reach anything. Every ingress op carries a `streamId` UUID minted inside `messages.send`, and `/ai/file` additionally requires the blob to belong to that stream's own thread (`chat.stream.attachmentInStream`). `ctx.storage.getUrl()` is a **bearer capability** — `storageId` is therefore never returned from any public function, and `url` is minted only after the ownership check, inside the handler.

`AI_INGRESS_SECRET` is distinct from `BACKEND_WEBHOOK_SECRET` on purpose: the latter is held by backend-echo, a different process in a different trust domain, and `/backend/webhook` falls through to `ingestEvent`, which would write one `events` row per token batch.

## Conventions that are easy to violate

- **`threadId` from a URL takes `v.string()` + `ctx.db.normalizeId(...)`, never `v.id()`.** A typo'd URL throws `ArgumentValidationError`, which the Convex client logs via `console.error`, which fails every e2e script. Anything rendered from a URL param must sit inside the not-found guard for the same reason.
- **`rehype-raw` is deliberately not installed.** Raw HTML in a model response is never parsed into nodes, so XSS safety is by construction rather than by filtering. If it is ever added, `rehype-sanitize` becomes mandatory. Invariant: `rg dangerouslySetInnerHTML` over the chat directory returns zero matches (only a comment explaining why).
- **`convex` is pinned to exactly `1.19.2`** in all four `package.json` files. A caret range lets bun silently re-resolve to 1.44 under a self-hosted 1.19 server. No Convex components beyond `polar` — changing the component tree on a live self-hosted backend is the highest-risk push category.
- **Biome, not ESLint/Prettier.** Run `biome lint`, not `biome check --write` — the latter reformats pre-existing files and produces a diff full of unrelated churn.
- **Never pass `budget_tokens` or `temperature` to Claude 5-series models** — they reject non-default sampling params with a 400. `services/ai/app/agent/llm.py` sets `temperature=None` for this reason.
- **New Convex tables must be additive.** The live deployment has pre-migration rows; a required field on an existing table fails schema validation on push.
- `/chat` lives in the **`(workspace)` route group**, not `(dashboard)` — it is full-bleed and renders neither the app sidebar nor the topbar. Route groups do not affect URLs. The routes that kept the dashboard shell (`/files`, `/settings`, `/settings/billing`) are reachable from the account menu at the foot of the conversation rail, which is their ONLY route out of the workspace.
- Chat UI uses `.h-dvh-safe` (in `packages/ui/src/globals.css`), not `h-screen` — Tailwind cannot express the `vh`/`dvh` fallback pair and `tailwind-merge` collapses it. The workspace accent is three tokens (`--brand` fills, `--brand-ink` text, `--brand-foreground` text-on-fill); one shade cannot be both a legible fill and legible text. Blue is much darker than green at equal HSL lightness, so unlike the old green theme the light fill takes NEAR-WHITE text.
- **`.workspace` in `globals.css` re-points the existing surface tokens** (`--card`, `--border`, `--background` …) for the chat subtree, so components re-skin without className churn. Radix portals mount outside it — any portalled surface needs `className="workspace"` or it renders against the base palette.
- New functionality is written in **Python** (LangChain / LangGraph / Pydantic / FastAPI) unless it is inherently Convex data-plane work. This is a standing repo policy.

## Cost controls (do not remove)

Unbounded context is the default failure mode of a chat product. Four layers, all deliberate:

1. Convex sends ≤60 messages + a rolling summary (`buildHistory`).
2. `trim_messages` against a **32k**-token budget — not the model's 1M window. A full 1M context is ~$5.00 per message at Opus-5 input rates.
3. `ai_max_turn_chars` (48k) bounds the *newest* turn, shared across all its documents. The history budget does not cover it, and the newest turn is where all the user-controlled bulk is.
4. `MAX_GENERATIONS_PER_HOUR` (120) per user. `MAX_CONCURRENT_STREAMS` bounds *parallel* generations only — `send → stop → retry` never runs more than one stream and is otherwise an unbounded billing loop.

## Ports

The AI service binds `127.0.0.1:8770`, **not 8000** — `deploy/47-glitchtip.sh` runs a cloudflared tunnel from a public `trycloudflare` URL to `localhost:8000`, and whichever process binds first wins.

## Deployment

`deploy/` is 62 numbered, idempotent shell scripts run in order on the VM; `deploy/54-ai-service.sh` is the AI service. `OPENROUTER_API_KEY` is never generated, never defaulted and never written by a script — an operator fills it into `services/ai/.env` (0600), and the script hard-fails until they do. It lives in **exactly one place**: the inference plane, which is the only thing that needs it to call a model. `convex/chat/models.ts` deliberately fetches the *unauthenticated* `/api/v1/models` (identical payload, no credentials) so the catalogue never becomes a second copy of the secret.

`ROADMAP.md` is the house record of what is done and what is deferred; keep it current rather than adding new status docs.

## Style (from `.cursorrules`)

Functional and declarative TypeScript; no classes. Named exports for components. Directories lowercase-with-dashes. `function` keyword for pure functions. Guard clauses and early returns. Zod for form validation. shadcn/Radix + Tailwind, mobile-first. Minimise `'use client'`, `useEffect` and `setState`; prefer Server Components, and use client components only for Web API access in small leaves. `nuqs` for URL search-param state.

One deliberate exception in chat: sub-components live at **module scope**, never nested inside a parent. The comment above `Shell` in `apps/app/src/components/auth-form.tsx` documents the bug — a nested sub-component remounts inputs on every keystroke, stealing focus, and in a composer it also breaks IME composition.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
