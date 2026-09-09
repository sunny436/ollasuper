# Roadmap

Deferred work, captured so it isn't lost. Ordered roughly by priority.

## Auth hardening — operator action still outstanding

The second auth audit (Better Auth as the reference) is shipped and prod-verified, but two items
cannot be closed from application code and are recorded here rather than implied as done.

- **Cloudflare rate-limiting rule on `/__cvx` and `/api/auth`.** `apps/app/src/middleware.ts` now
  throttles `/api/auth` per IP on `cf-connecting-ip` (verified on prod: 60×200 then 429). That is
  defence in depth, **not** a closure. `NEXT_PUBLIC_CONVEX_URL` is public, so a caller can invoke
  `auth:signIn` on `app.ollasuper.com/__cvx` directly and never touch Next — which is exactly what
  `e2e/p-auth-oracle.js` does. Convex actions receive no request object, so no application-level
  limit can cover that path. Only a Cloudflare rule spanning **both** paths can. Until it exists,
  credential-stuffing across many accounts is bounded only per-account (5/hour), and the per-account
  lockout DoS (5 failed code attempts against a named victim) has no IP-side brake.
- **Convex returns full stack traces to unauthenticated callers.** Measured on production: a thrown
  error reaches the client as `Server Error Uncaught ... at authorize (../../convex/
  passwordProvider.ts:NNN)`. Using `ConvexError` gives a clean `.data` for the UI but does **not**
  suppress the trace. It is no longer an enumeration oracle — every auth failure now throws the same
  error from the same line — but the source-path disclosure is deployment-wide behaviour and needs a
  Convex-level setting, not an app-level change.

One finding is verified by unit test only, and deliberately so:

- **`accountStatus` enforcement (suspended accounts).** Now checked at login and in `chat/authz.ts`,
  covered by two convex-test cases against the real functions. It is **not** prod-verified, because
  nothing in the product can set `accountStatus` to `"suspended"` — there is no admin surface, which
  is precisely why the gap sat unnoticed with a single consumer in `scheduled/authz.ts`. Verifying it
  on prod would mean shipping a mutation that exists only for the test. When an admin/suspension
  surface is built, add the prod check with it.

## Agentic runtime program (Phases 0–12) — architecture built + test-proven

A separate 0–12 program (distinct from the product "Phase N" sections below) built an all-rounder agentic
runtime in `services/ai`. **Full design reference: [`services/ai/ARCHITECTURE.md`](services/ai/ARCHITECTURE.md).**

- **Phases 1–8 (durable execution engine) are LIVE** in `app/runtime/runner.py`: durable tool execution,
  identity/lifecycle, at-most-once side effects, crash recovery, all-or-pause approval, bounded parallelism,
  context budgets, capability authorization, and the observability ledger.
- **Phases 9–12 (agent · orchestrator · dynamic capability-resolution · skills · `AgenticRuntime`) are built and
  fully test-proven but NOT yet wired into the live streaming path** (Option A throughout). The live chat still
  runs the Phase 1–8 loop with `ai_agent_discovery_top_k = 5`.
- **Verification:** `cd services/ai && uv run ruff check . && uv run pytest` → **437 passed, 11 skipped** (incl.
  the 21-test Phase-12 E2E suite covering all 22 acceptance scenarios); Convex `bun run test` 192 pass;
  `bun run typecheck` 7/7. All Phase 9–12 work is Python-only + additive (no Convex/schema change).
- **Remaining productionization (deferred, deploy-gated):** wire `AgenticRuntime` into the live streaming
  `runner.py` (the invoke→stream integration + multi-agent streaming), fold window-aware `ContextBudget` into
  the orchestrated path, add durable Convex ROUTE/SKILL observability events — then prod headed-Chrome
  verification. Not production-ready merely because tests pass (see ARCHITECTURE.md "Known limitations").

## Scheduled Tasks program (Phases 0–4) — 1–3 built, NOT deployed

A four-phase program building self-hosted scheduled tasks. **Nothing in it is on the VM yet**;
deployment is deliberately Phase 4, so `main`'s live behaviour is unchanged by phases 1–3.

- **Phase 1 — durable scheduling foundation (built + tested).** DBOS Transact 2.31 on Postgres
  (`myos_dbos`, its own `myos-scheduler.service`), driving three additive Convex tables
  (`scheduledTasks` · immutable `scheduledTaskRevisions` · `scheduledTaskOccurrences`). The
  no-silent-loss guarantee is the occurrence: every intended run gets a durable
  `"<taskId>:<kind>:<scheduledForMs>"` identity, so N missed runs are N executions, never coalesced.
  Same-task serialization is a DBOS partitioned queue (`partition_concurrency=1`); the claim mutation
  is the authority, not process memory. Recurrence maths is pure stdlib `zoneinfo` — month-end clamp,
  DST-gap bisection, `fold=0` for ambiguous times.
- **Phase 2 — AI execution (built + live-verified locally).** An occurrence drives the *existing*
  chat path (`startAssistantTurn` → `/v1/generate`); there is no second runtime. Scheduled turns are
  `unattended`, which pins the tool scope read-only and refuses an approval park instead of hanging
  a run forever. Scheduled threads are hidden from `threads.list`, `listPinned` and search.
- **Phase 3 — UI, management, history, in-app updates (built + tested).** `/scheduled` and
  `/scheduled/[taskId]` in the `(workspace)` group, sharing the conversation rail with chat (the rail
  moved verbatim into `_components/workspace-rail.tsx`). A conversational composer parses natural
  language via `POST /v1/schedule/parse` — a module that **structurally cannot create a task**: it
  imports no Convex client and has no write path, and nothing is persisted before an explicit
  Confirm on an editable card. Results render through the existing chat renderers behind a new
  `readOnly` flag on `ChatMessage`, so the viewer offers no mutating action. `endsAt` on
  daily/weekly/monthly is the **only** change to Phase 1 scheduler semantics.
- **Verification (local only).** Convex `bun run test` → 304 passed / 1 skipped (19 files);
  `services/ai` → 1015 passed / 16 skipped + `ruff` clean; `bun run typecheck` 7/7; `bun run lint`
  clean; production build emits both new routes. The parse endpoint was probed live against the real
  configured model (20/20: auth, size caps, all five recurrence kinds, `endsAt`, ambiguity, a
  correction against a standing draft, and prompt injection in the scheduled text).
- **Phase 4 — delivery, hardening. DEPLOYED AND PROVEN 2026-09-01** (this bullet said "NOTHING
  DEPLOYED" while delivery was in fact armed in production and mailing into a local catcher —
  see the Ollastack entry below). PDF reports and
  email delivery run as a state machine SEPARATE from execution (`scheduledDeliveries`), so a bounce
  can never put a model turn back on the queue. `POST /v1/report/pdf` renders markdown → the existing
  `filegen` reportlab pipeline and, like the Phase 3 parser, **has no write path at all** — payload
  in, bytes out, no Convex client — so ownership never leaves Convex. Email is **opt-in per task**
  (absent ⇒ off, the inverse of the in-app pair) and fail-closed: an unset Resend key is a recorded
  failure, never a silent fall back to the VM's local Mailpit catcher. Plus the scheduled-execution
  rate window (enforced at *claim*, so an exhausted budget queues rather than burning a retry),
  loopback-only scheduler health that goes red when ticks stop, Sentry on the scheduler, and
  systemd limits derived from the host's own memory.
- **Four pre-existing defects found and fixed on the way:**
  **(1) P0 — the nightly backup was archiving the wrong deployment.** `backup.sh` chose its target by
  asking whether `/root/.cvx-cloud-key` exists; nothing ever deleted that file, so every backup since
  the PostgreSQL cutover archived the frozen Cloud rollback copy while the live deployment went
  unprotected. Target is now explicit (`BACKUP_TARGET`, defaulting to self-hosted), with structural
  integrity checks and a checksum manifest. `deploy/backup.test.sh` covers it, 11/11.
  **(2) P0 — the scheduler would have thrown on every tick in production.** Two log lines passed
  `extra={"created": …}`; `created` is a reserved `LogRecord` field and `logging` raises rather than
  overwriting it. Invisible in tests (INFO is off, so no record is built) and fatal at production's
  log level. A static scan now covers every `extra={}` in the codebase.
  **(3) P1 — `dbos` was a version RANGE** while DBOS migrates its system database at launch; pinned
  exactly, with a startup gate. **(4) P1 — no restore path existed at all**; `deploy/72-restore-drill.sh`
  now exists.
- **Verification (local only).** Convex **347 passed** / 1 skipped (21 files); `services/ai` **1220
  passed** / 16 skipped, `ruff` clean; `bun run typecheck` 7/7; `bun run lint` clean; production build
  emits both routes.
- **NOT VERIFIED — needs infrastructure this machine does not have.** Docker is not installed here, so
  the local full-stack replica (`deploy/replica/compose.replica.yml`) has never been brought up, and
  therefore: **DBOS has still only ever run against SQLite**, and none of the recovery drills
  (`deploy/73-drills.sh`), the restore drill, or the load tests have been executed. Production access
  was declined, so `deploy/71`, the deployment, the smoke test and `e2e/p-scheduled.js` have never
  been run either. See the 45-row acceptance form in the Phase 4 plan.

### Auth hardening — six defects, one critical (2026-09-01)

A two-pass audit of the real code, including `@convex-dev/auth`'s internals. Of the three symptoms
reported, two were real with a **different root cause than assumed** and one was **refuted**: OTP *is*
the final gate (`Password.js:142` denies a session to any account whose email is unverified), and
case/whitespace **cannot** bypass uniqueness (both providers normalise).

| # | Defect | Fix |
|---|---|---|
| **B2** *(CRITICAL)* | `flow: "signUp"` against an existing account ran a real scrypt comparison, then threw `Account <email> already exists` on a wrong password or **returned a session** on a correct one. The library's limiter lives only in `retrieveAccountWithCredentials` and `verifyCodeAndSignIn`, so `maxFailedAttempsPerHour: 5` never applied — unlimited password guessing plus enumeration, on a public endpoint. | Password provider replaced by a near-verbatim copy on `ConvexCredentials`, differing in one branch: the account is looked up **without** a secret and the flow takes the same `signInViaProvider(verify)` branch a fresh sign-up ends on. |
| **B1** | Linking matches only a **verified** user, so password-signup-then-Google made a second `users` row; the password stayed on the orphan. | Post-hoc reconcile in `afterUserCreatedOrUpdated`. Safe because an unverified account **can own nothing** — verified three ways. Two verified accounts are never merged. |
| **B3** | `accountExists` was `query`, i.e. publicly callable, while its own comment claimed otherwise — defeating the enumeration-safe `requestPasswordReset` beside it. | `internalQuery`. |
| **B4** | Its fallback `.collect()`-ed the whole users table per unknown-email probe. | Bounded index range over pre-migration rows only. |
| **B5/B6** | Squat an address, never verify, and the owner can never register — no expiry, no recovery. | Hourly purge, 24-hour TTL, skipping live codes and sessions, deleting `users` + `authAccounts` + codes together. |

**Found during implementation, and live in production:** `createVerificationCodeImpl` does
`profile: { email }` from the **raw** identifier and upserts it, so every sign-up typed with a capital
letter overwrote `users.email` with `"Foo@Gmail.com"`. That column is the one
`uniqueUserWithVerifiedEmail` indexes — a direct cause of B1. Fixed at both ends.

**Three cheaper fixes for B2 were tried and rejected with reasons:** a wrapper around `auth:signIn`
(the library's action must stay public for login, OTP, OAuth and refresh, so it is bypassable by
name), `profile()` (invoked synchronously, so it cannot read the database), and
`afterUserCreatedOrUpdated` (never fires on a correct-password collision).

**Prod-verified:** `p-auth-oracle` **7/7** — browserless against the real deployment, because the
defect was never reachable through the UI: correct and wrong passwords now return byte-identical
responses, a registered address is indistinguishable from a fresh one, and `accountExists` is no
longer publicly callable. Plus auth **7/7**, auth edges **9/9**, chat isolation **13/13**, scheduled
isolation **18/18**, chat answering. Backend **555 passed / 1 skipped**; typecheck 7/7; lint clean.

**Known limitations, stated rather than implied:** no rate limit anywhere has an **IP dimension**, so
spraying across many addresses is unbounded; and **Convex has no unique constraints**, so "one email,
one user" is an application invariant held by a serialised read-then-write, not a database guarantee.

### Scheduled report emails render the report (2026-09-01)

The report renderer understood **three** block types — headings, `-` bullets, paragraphs — and wrapped
them in no layout at all. A real production email read:

```html
<h1>SEO Brief: Interaction to Next Paint (INP)</h1>
<p>**INP (Interaction to Next Paint)** — the Core Web Vital…</p>
<p>1. **Break up long tasks…** (`setTimeout`…)</p>
```

Literal asterisks, literal backticks, numbered items flattened, and a bare fragment with no branding.

- **`convex/reportMarkdown.ts`** (new, plain, no deps) adds bold, italic, inline code, fenced code,
  ordered lists with `start`, nested bullets, links, blockquotes, rules and GFM tables — inside the
  **same shell as the auth email** (`renderShell`), so the two cannot drift.
- **THE ESCAPING ORDER IS INVERTED, and that is the point.** The old renderer escaped the document
  then looked for block shapes in the escaped text. That works only while the markers are characters
  `esc` leaves alone; it **corrupts** any URL, turning `?a=1&b=2` into `?a=1&amp;b=2` before the href
  is extracted. Structure is now parsed on the RAW text and every leaf escaped at emit: every text
  node through `esc()`, every href through `safeUrl()` **then** `esc()`.
- **`safeUrl` MOVED** from `apps/app` to `convex/urlGuard.ts` rather than being copied — chat and the
  email renderer both need it and live in different packages. It had **zero tests** in the app and
  now has 22, including the control-character bypass its own comment documents.
- **Long reports** are cut between blocks — never inside a table or fence — and say so, with a link
  to the full result. Distinct from the pre-existing `MAX_MARKDOWN_CHARS` cut, which is a different
  event and now has its own wording.
- **Three bugs caught before or during production verification:**
  (1) a URL with balanced parentheses (every Wikipedia link) was truncated at the first `)`, leaving
  a stray bracket in the prose; (2) a nested list was emitted as a **sibling** of its parent `<li>`,
  invalid HTML that Outlook renders as an extra bullet; (3) **the timestamp silently fell back to
  UTC** — ECMA-402 forbids combining `dateStyle`/`timeStyle` with `timeZoneName`, so `Intl` threw and
  the fallback took over, losing the task's timezone. Found only by reading a real received email.
- **Prod-verified deterministically**, by invoking the real send action with crafted fixtures so the
  model's nondeterminism cannot make the assertions flaky: a formatting-heavy report (every block
  type) and a hostile report. In the received mail, `<strong> <em> <code> <ol> <ul> <table> <th>
  <blockquote> <pre> <hr> <a href>` all present; `**`, `](`, `|---|` all absent; every hostile
  construct inert but still visible as escaped text; `?a=1&amp;b=2` and `Foo_(bar)` hrefs both
  correct; `Generated 1 Sept 2026, 16:31 GMT+5:30` in the task's own zone.
- **Spam gate passed** — the richer HTML did **not** increase classification; both new report emails
  landed in the normal inbox, with only the two pre-existing SEO reports still in spam.
- Backend **532 passed / 1 skipped**; typecheck 7/7; lint clean. The 30 auth-email tests pass
  untouched, which is what proves the shell extraction changed nothing.

### Auth emails are branded HTML (2026-09-01)

One-time codes went out as a single line of plain text. They now carry a branded HTML part
**alongside** the text one — multipart, so a client that strips HTML still shows a usable code, and
so the provider's OTP extractor still sees the shape it recognises.

Every value comes from the auth implementation, not from the design reference, which was wrong on
five counts: 6-digit code (**ours are 8**), 10-minute expiry (**ours is 15**), "Ollasuper" (**the
wordmark is `OLLASUPER`**), Inter via Google Fonts (**the app uses self-hosted Plus Jakarta Sans**,
which no mail client will load), and a Contact Support link (**no support address exists anywhere in
this product** — omitted rather than invented).

- **The expiry is not a constant.** `@convex-dev/auth` already hands every provider `expires` — the
  value it computed from `maxAge` and the value it enforces — and all three were discarding it. The
  email renders that, so it cannot drift from what the backend accepts. `maxAge` is untouched.
- **Subjects are unchanged, deliberately.** Two e2e suites locate the code by matching the label in
  the subject, and `p-mail.js` separates auth mail from report mail the same way.
- `esc()` moved from `email.ts` into a new plain `emailTemplates.ts`: `authCodes.ts` is plain and
  cannot import from a `"use node"` module. Same constraint that produced `ollastack.ts`.
- Real-client details: `letter-spacing` rather than literal spaces (spaces make the code paste as
  `8392 0174`); an explicit light `color-scheme` (Apple Mail and Outlook otherwise invert the card
  into near-black on near-black); and a preheader carrying the expiry and **never** the code, since
  that line is the phone's lock-screen preview.
- The greeting is optional and never guessed — `deliverCode` knows only an address, and a magic-OTP
  sign-in can precede any user row.
- **Bug found and fixed:** the provider's OTP extractor ranks candidates heuristically and returned
  `["1192","11923532"]` — a 4-digit **prefix** ahead of the real code. The e2e helper trusted
  `codes[0]`. The assertion was right and stayed; the helper now picks the longest digit run.
- **Deliverability gate PASSED:** branded auth mail lands in the normal inbox, verified against the
  provider's `?spam=true` view. Only the two old SEO reports sit in spam.
- **Prod-verified:** auth 7/7, auth edges **9/9** (now including the magic-OTP flow, previously
  untested), scheduled report 7/7. All three templates confirmed in real received mail — "Verify your
  email", "Reset your password", "Sign in to OllaSuper" — each with the real name, the real 8-digit
  code and "expires in 15 minutes". 4.2 KB, no images, no webfont, no script, no tracking pixel.
- **NOT verified:** Gmail/Outlook rendering — still needs a mailbox at each provider we can read.

### Mail: Ollastack is the outbound transport (2026-09-01)

**The stated position above — "real email has never been sent" — was wrong in the worst direction.**
Delivery *was* armed in production (`SCHEDULED_DELIVERY_ENABLED=true`) with
`SCHEDULED_EMAIL_TRANSPORT=smtp` pointing at `SMTP_HOST=172.18.0.1:1025`, the **Mailpit container**.
So every scheduled report and every auth code — OTP, email verification, password reset — was
delivered into a local catcher on the VM while the state machine recorded `accepted` and the UI
showed the run as sent. Mailpit held 32 messages, including a real user's verification code.
Mandatory email verification meant **no real user could complete signup or reset a password.**

`deploy/71` had a guard against exactly this and it never fired: it grepped `services/ai/.env`, while
the live value sits in the **Convex deployment env** — a store the Python service never reads.

- **Transport:** `ollastack` is now a named transport for both mail paths, free tier, sending as
  `auth@` / `reports@agent.ollastack.com`. Monthly send cap is **1500** (not uncapped);
  `deploy/75-ollastack-mail.sh` warns past 80%.
- **A 2xx is not a send.** The response carries the stored message, whose `deliveryStatus` may be
  `dry_run` (accepted and discarded) or `failed`. Only `sent`/`sending` count as custody.
- **Unknown transport names fail closed**, so a stale value cannot fall through to the catcher.
- **The runtime refuses `smtp`** whenever `SITE_URL` is not loopback; `ALLOW_SMTP_TRANSPORT=1` is the
  explicit replica opt-in. A deploy-time gate alone was already proven insufficient.
- **No `Idempotency-Key` exists on this provider**, so a crashed send is never blind-retried. It goes
  to `indeterminate`, and a new 5-minute `reconcile` cron resolves it against the provider's outbound
  log: no match ⇒ safe re-queue, one match ⇒ real outcome, more than one ⇒ refuses to guess.
- **No delivery webhook and no bounce feed exist** (`/failures` is the *inbound* trail), so
  `delivered`/`bounced`/`complained` are states this system can no longer enter. `accepted` is the
  strongest honest claim and the UI never exceeds it. Bounce-driven auto-disable survives only via a
  send-time `invalid_recipient`. **Known limitation, deliberately not papered over.**
- **Rollback is never `smtp` here** — that is Mailpit. Reports roll back to `disabled`; auth has no
  fallback and fails visibly.
- `mail.ollasuper.com` needs only a verified domain plus `OLLASTACK_MAIL_DOMAIN` — **no code change**.
- **Also fixed:** the client-side signup domain allow-list had no `AUTH_EXTRA_ALLOWED_DOMAINS`
  equivalent, so the browser rejected addresses the backend accepted. That is why the auth e2e could
  never test against a real inbox, and so why a stack that could mail nobody kept passing.
- **Prod-verified, headed Chrome on `app.ollasuper.com` unless noted — 134 scenarios, 134 passed:**
  auth 7/7 · auth edges 8/8 (including a superseded code being dead) · scheduled report + PDF 7/7 ×
  **4 prompt classes** (plain, tools, skill, skill+tools) · scheduled UI 33/33 · chat 17/17 ·
  chat isolation 13/13 · scheduled isolation 18/18 · scheduler restart drill 9/9 · browserless chat
  probe 1/1. Backend 427 passed / 1 skipped; typecheck 7/7; lint + sherif clean.
  Reconciliation observed confirming rows at `accepted` on its 5-minute cadence, and **Mailpit's
  count stayed at exactly 32 from first deploy to last test** — nothing was swallowed locally.
- **Deliverability, measured not assumed:** report content is *intermittently* classified as hard
  spam on the receiving side (`ml_classifier+keyword`) — 2 of 3 SEO-shaped reports filtered; plain,
  tool and blog reports never. An agent mailbox hides hard spam from the normal list, `/wait` and
  webhooks, so a filtered message is indistinguishable from one never sent; `e2e/p-mail.js` now
  checks the spam view and says which happened. This is the concrete case for `mail.ollasuper.com`.
- **NOT verified:** inbox-vs-spam placement at Gmail and Outlook. That needs a mailbox at each
  provider to read; none exists in this workspace, and sending to addresses we do not own would
  bounce against a shared domain's reputation. Genuinely blocked on an operator-supplied address.
- **Crash-during-send** is covered by unit tests and by the live reconciler; a real induced crash
  belongs on the replica, which has never been brought up (no Docker on the dev machine). The
  scheduler restart drill (9/9, a real service restart) is the closest non-destructive analogue.

## ✅ Done (current state)
Self-hosted Convex (Docker) · multi-tenant backend (workspaces/RBAC/invites) · hybrid backend adapter (proxy / JWKS-direct / webhook) · usage · API keys · audit · events · files · **AI chat at `/chat`** (Convex data plane + Python inference plane → OpenRouter; real streaming, search, attachments — see the AI chat section below) · **full auth** (email+password, mandatory email verification, password reset, magic OTP, Google provider [creds pending], password policy, brute-force lockout 5/hr) · real HTTPS via Cloudflare tunnel · **left sidebar shell** + reactive workspace switcher + responsive drawer · **toasts + confirm dialogs** · CI (typecheck+lint) + branch protection · nightly backup (**see the backup entry under Notes — this was listed as done but had never actually run on the current VM**).

## Phase 8 (2026-08-23) — Agentic UX + Production Hardening

Shipped as three reviewable PRs (8a agentic UX · 8b durable approval · 8c hardening + docs).
The typed event protocol (Phase 3) was already emitted + persisted end-to-end, so Phase 8 was
overwhelmingly EXPOSE + SECURE + OBSERVE, not new architecture.

### A. UX before → after
Before: `User → text response`. After: `User → agent activity (tool panels, progress) → sources /
citations / RAG provenance → artifacts → final answer`, with a durable approval dialog for any
approval-gated tool and friendly, retry-gated errors. A pure-text turn renders exactly as before
(the activity UI returns null), so ordinary chat is visually unchanged.

### B. Event → UI mapping (`apps/app/.../chat/_lib/agent-events.ts` + `_components/`)
`TEXT_DELTA`→StreamingText (chunk stream) · `TOOL_CALL`/`TOOL_RESULT`/`TOOL_PROGRESS`→AgentActivity
`ToolRun` panels (paired by call_id; safe `ResultPreview`) · `CITATION`→SourceList/CitationCard ·
`ARTIFACT`→ArtifactCard · `APPROVAL_REQUEST`→ApprovalCard · `FINAL`/`ERROR`→terminal marker /
ErrorNotice. `TOOL_RESULT.content` (the verbatim context/near-CoT block) is dropped at parse time so
no component can render it; unknown event/shape types fail gracefully.

### C. Approval flow (durable, Phase-7-substrate)
`tool needs approval → op:"approval" parks a chatApprovals row + stream→waiting_approval (invisible
to the reaper) → user Approve/Reject (or expiry) → resolve mints the execute token + requeues +
redispatch → Python executes the approved tool exactly once / injects a rejection`. Survives refresh,
reconnect, worker restart, backend restart. A late finalize from a crashed/duplicate run NO-OPS on
`waiting_approval` (cannot destroy the parked approval); the token is the only execute capability and
never reaches the browser.

### D. Security
Auth/authz unchanged (user-boundary chat, "Not found" not "Forbidden", ids from session). Approval
`resolve` is owner-only. RAG/memory retrieval scope is the authenticated id, never model args
(`test_user_id_comes_from_ctx_not_args`). Retrieved/tool content is framed as DATA and closing
sentinels neutralized (`test_prompt_injection.py` — 4 tests pin it). No `rehype-raw`; exactly one
`dangerouslySetInnerHTML` (mermaid, strict). Approval token is server→Python only.

### E. Production hardening
- **Audit**: `agent.execution` / `agent.execution_failed` (ingest.ts, gated on hasEvents) +
  `agent.approval_requested/approved/rejected` (approvals.ts) — ids/counts only, never payloads/CoT.
- **Observability**: `main.py` reports unhandled inference-plane errors to GlitchTip/Sentry when
  `AI_SENTRY_DSN` is set, scrubbed through the shared log redactor (`redact_text`). Guarded on an
  optional import — **deploy step**: `uv add sentry-sdk[fastapi]` + set `AI_SENTRY_DSN` (mirror
  `deploy/48`). streamId + attempt already correlate logs end-to-end.
- **Errors**: centralized `errorCode → {message, retryable}` map on the frontend (`agent-events.ts`),
  hides Retry for non-retryable codes; backend `retry` remains the real idempotency gate.
- **Retries / recovery / rate limits / cost**: unchanged from Phase 7 (see deferrals).

### F. Files changed — see PRs #63 (8a), #64 (8b), and this PR (8c).

### G. Tests (before → after)
8a: +19 bun-test units (parse/timeline/label/error) + Scenario-A e2e assertion. 8b: +11 convex
approval tests, +6 pytest approval tests, 2 Phase-4 approval tests updated to the suspend contract.
8c: +4 injection tests + 2 agent-audit assertions. Full suites: pytest **247 passed** / ruff clean;
Convex **171 passed** (the 2 `/ai/file` timeouts are the known full-suite flake, pass in isolation);
typecheck/biome/build all green.

### H. Regression — chat, Ollima, RAG, memory, tools, streaming, auth, file upload, cancellation all
green (full Phase 0–7 suites pass).

### I. Remaining gaps (NOT claimed done)
- **Presentation-only** (built against the verified payload contracts, not yet emitted by any tool):
  `TOOL_PROGRESS` line, `ArtifactCard` download (needs a capability url; only `artifact_type:"memory"`
  emitted today), `ResultPreview` chart branch. They fail gracefully and light up when the backend emits.
- **Approval** is verified hermetically + via the staging force-flag; **no real high-impact tool ships
  enabled**, so the production headed-Chrome round-trip is the final gate, pending a deploy.
- **Cost (USD)** deliberately NOT computed — Ollima `/v1/models` prices are empty, so `costUsd` would
  persist fake zeros. Ollagraph `x-credits-cost` is captured + logged; aggregate it via `recordUsage`
  when Ollagraph tools go live. `costUsd` stays intentionally null until a priced catalogue exists.
- **Provider capability columns** NOT added — no data source (Ollima returns only the id); the
  family-keyed quirk map (`llm.py`) + the `contextWindow 0 = unknown` contract are the honest
  representation; the UI degrades gracefully.
- **Rate limits**: per-user hourly + concurrency + step-budget + deadline suffice for one provider. A
  workspace-aggregate window is the designed extension point (build with a spend requirement); no
  per-tool limiter (redundant with the step budget).
- **Backup / recovery gaps** (documented, code deferred):
  1. All backups land on the same VM (`/opt/backups`) — no offsite copy. Highest-severity gap;
     recommend an `rclone`/`scp` step after `backup.sh` to object storage.
  2. The logical `convex export` is not a full restore image — self-hosted rollback needs the
     module blobs / search indexes re-deployed in the load-bearing import-before-deploy order
     (CLAUDE.md), and the Polar `customers` join is component state the export does not cover.
  3. In-flight execution state (running/queued streams, scheduler rows) is not point-in-time
     recoverable; the reaper recovers a live deployment, not a restore.
  4. Restore is never tested — recommend a monthly restore into the dev-Cloud harness
     (`deploy/60-convex-cloud-dev.sh`).

## 0d. Chat sharing (2026-08-20) — snapshot-based public links
Two share actions — **Share Chat** (header) and **Share Response** (per assistant turn) — mint
unique public links: 7-day server-enforced expiry, **snapshot-based** (content frozen at share
time, so later edits never change a live share), revocable, read-only. Engine in
`convex/chat/shares.ts` + the `chatShares` table.

- Token is 192-bit `crypto.getRandomValues` hex (apiKeys idiom), **stored plaintext + indexed**
  (the manager "Copy link" needs it retrievable; blast radius is low — read-only/7-day/revocable).
- `getByToken` is a PUBLIC query (never calls auth) returning a sanitized payload — no
  userId/email/storageId/internal-ids/reasoning/systemPrompt. Owner-only create/revoke via
  `requireThreadAccess`/`requireMessageAccess`. Snapshot excludes in-flight rows and inactive
  variants; single-turn exposes ONLY the user+assistant pair.
- Public page `(public)/share/[token]` is a Server Component + `generateMetadata` (OG title = the
  conversation title, never message bodies; noindex; static `/logo.png` card). Reuses `<Markdown>`
  (XSS-safe, no rehype-raw), fixed-UTC timestamps (no hydration mismatch), clean
  expired/revoked/invalid states. `middleware.ts` bypasses auth for `/share/*` (still
  locale-rewritten) + a best-effort in-memory per-IP throttle.
- Attachments serve through a **revocable** `/share/file` httpAction proxy (mirrors `/ai/file`):
  404 no-oracle, `storageId` server-only, scoped to the snapshot — never the file library. A
  stored `getUrl()` was rejected because it is a permanent bearer link.
- `Shared Chats` account-menu item → `/settings/shared` manager (filter/search/copy/open/revoke).
- Tests: 8 convex-test cases (snapshot fidelity, turn + cross-user isolation, expiry, revocation,
  dedup, rate-limit) + `e2e/p-share.js` (create → open unauthenticated → revoke → invalid).

## 0c. Ambience theme (2026-08-19) — continuous slider replaces Light/Dark/System
The discrete next-themes control was replaced by a continuous **Ambience slider (0–100)**
that themes the whole app through **Daylight → warm Amber → Midnight**, plus a Gemini-style
empty-`/chat` landing (parallax glow orbs + a starfield). Engine in `apps/app/src/lib/ambience`.

- **Reversible by construction:** `globals.css` reads every token from
  `var(--amb-<token>, <today's-literal>)`; the engine writes `--amb-*` on `<html>` only
  (inheritance covers all scopes + late Radix `.workspace` portals). Engine off
  (`NEXT_PUBLIC_AMBIENCE=off`) → pixel-identical to before. `tailwind.config` untouched.
  next-themes was retired (it was the sole `useTheme` consumer via `theme-switcher`).
- **No mid-transition washout:** surfaces interpolate through 4 stops
  `[day, amber(50%), dusk(75%), night]`; **text tokens never lerp through grey** — each
  outputs whichever ink (light day→amber / dark night) has the higher WCAG contrast against
  its paired surface. `primary` is a text token (it's the body text; `text-muted-foreground`
  is unused in chat). A smooth light→dark surface must cross medium luminance, where even
  black/white caps ~3.9:1, so body text is **≥3.5 through the ~52–76% crossover and ≥4.5
  elsewhere** (vs the ~1.3 wash before). Guarded by `contrast.check.ts`, wired into CI via
  the apps/app `test` script.
- **No flash:** a pre-hydration inline script mirrors the engine math (byte-exact parity
  verified) and stamps vars + `.dark` before paint. `.dark` toggles off the interpolated
  background luminance so `dark:` utilities + Shiki flip in lockstep with the text.
- Accents (user bubble, Send button, dictation-active mic) ride `--brand`, so they warm to
  bronze at the amber phase.
- **Cross-device sync** (shipped): an additive `chatSettings.ambience` field + `updatedAt`
  persist the theme per user+workspace; `<AmbienceSync/>` (in both route-group layouts)
  reconciles local↔server by **last-write-wins timestamp** so a fresh local change never
  loses to a stale server value, while localStorage still wins the pre-paint render (no flash).

## 0b. Workspace re-skin (2026-08-18) — `/chat` goes full-bleed
`/chat` moved from the `(dashboard)` route group to a sibling **`(workspace)`** group, so it no
longer renders the app sidebar or the topbar. Route groups do not affect URLs. With the app rail
gone the conversation rail docks at `md` instead of `xl` and gained a collapse toggle; the account
menu at the foot of that rail is now the **only** route out to `/settings`, `/files` and
`/billing`, which kept the dashboard shell.

- Surfaces are re-skinned by a `.workspace` block in `globals.css` that re-points the *existing*
  tokens, so components changed appearance without className churn. Radix portals mount outside
  that scope and need `className="workspace"` (the model dropdown does).
- The brand accent moved from green to sky/indigo/purple, re-derived for both themes. Blue is much
  darker than green at equal HSL lightness, so the light fill takes near-white text where green
  took near-black. Ratios verified against the shipped CSS: light 5.98 / 8.59 / 6.26, dark
  8.02 / 8.84 / 8.84.
- The rail orb reuses `components/auth/intelligence-core.tsx` through `next/dynamic({ssr:false})`.
- Deliberately **not** built: the artifact/canvas panel from the prototype — the ask was a simple
  ChatGPT/Gemini-style chat.
- Rail collapse is a CSS width transition, not framer-motion: `/chat` is the landing route and
  framer-motion is ~40kB gz for something CSS composites free. `/chat` first-load went 292 → 305kB.

## 0. Section removal (2026-08-16) — chat-first surface
The Dashboard, Sessions, Jobs and Platform sections were removed and `/` now redirects to `/chat`.
(Two of the six sections named in the request — **Devices** and **AI Access** — did not exist in
this repository; nothing was removed for them.) Remaining surfaces: **Chat · Files · Settings ·
Billing**.

- Deleted: the `/` (Dashboard), `/jobs` and `/platform` routes; `components/sessions-card.tsx`;
  `convex/jobs.ts`, `convex/dashboard.ts`, `convex/sessions.ts`; the `jobs` table;
  `counters.readCounters()`; the `job.result` branch of `/backend/webhook`.
- **Kept, deliberately:** `orgs`/`apiKeys`/`usage`/`audit`/`notifications` and the `counters`,
  `events`, `apiKeys`, `usage`, `auditLogs`, `workspaces`, `members`, `invites` tables. Platform
  was only their *UI*. Tenancy, billing, auth and every chat/files path still depend on them, and
  `backend-echo` on `:4000` still writes `events` through `/backend/webhook`.
- `seed.firstUserId` took over from `jobs.firstUserId`; ~10 `deploy/` scripts use it as a generic
  operator helper and were retargeted.
- Removed with the sections: `e2e/p-home.js`, `p-sessions.js`, `p-paging.js`, `p-feedback.js`, and
  `deploy/14-jobs.sh`, `15-verify-jobs.sh`, `39-home.sh`, `43-sessions.sh`. `43-sessions.sh` also
  carried the only `DEV_SEED` gate probe — `devGuard.ts` is untouched, but that probe is now gone.

## 1. Dashboard UX (remaining increments)
> Superseded by section 0 for the home/sessions items — the home overview and the active-sessions
> UI were removed rather than built out. The rest still stands.
- **Settings restructure** — sectioned settings (Profile · Notifications · Team · Billing · API keys · Danger zone); **change password**; **delete account** (`deleteCurrentUserAccount` exists, needs UI).
- **Command palette (⌘K)** (cmdk).
- ~~**Notifications center**~~ — **DONE**. `notifications` table + `notify()` (serialisable dedupe),
  `myNotifications` (paged) / `unreadCount` / `markRead` / `markAllRead`, and a `DropdownMenu`-based
  centre in the chat header (between Share and the ambience control) and on `/scheduled`, which has
  no header of its own. Emitters: scheduled run terminal states, delivery email-disabled, tool
  approval required/expired, chat turn failed, and chat turns past a 2-minute threshold — the last
  three skipped for `status: "scheduled"` threads so a scheduled run is never announced twice.
  Severity is derived from `type`, not stored. Prod-verified 15/15 headed Chrome.
  **Known limitation:** the table has no retention cron; `markAllRead` is bounded per call instead.
- **Pagination / load-more** on files / audit / events (closes audit **BUG-8**; queries currently `take(50)` / unbounded `.collect()`).
- **Unified Files — shipped, with two deliberate limits.** Both Files pages (`/files`,
  `/settings/files`) now route an upload by FILE TYPE: anything the ingest pipeline can read
  takes the same `userFiles` path the chat paperclip uses, everything else stays a plain
  `files` row, and both pages list both collections. So searchability no longer depends on
  which page uploaded a file. Two things were left undone on purpose:
  (a) **existing `files` rows are not migrated** — a legacy upload stays non-searchable until
  it is re-uploaded, because sharing one `storageId` across both tables would let
  `files.remove` delete the blob out from under `userFiles`, and copying blobs server-side
  is neither minimal nor safe;
  (b) **an ingestible upload on `/files` is now owner-private, not workspace-shared** —
  `userFiles` is per-user by design (chat's trust model), so this is strictly less sharing
  than before, but it IS a behaviour change for anyone who used `/files` to hand a document
  to a colleague. Pre-existing `files` rows are untouched and stay workspace-visible.
  If workspace-shared searchable files are ever wanted, that is a new capability
  (a workspace-scoped ingest + retrieval scope), not a tweak to this routing.
- **Polish** — loading skeletons, consistent empty states, 404 page + error boundary, footer/version, help/docs link, keyboard shortcuts.

## 2. Production-readiness
- **Named Cloudflare tunnel + real domain — SCRIPTED (2026-08-17), not yet run.** `app.ollasuper.com`
  (`:3000`), `convex.ollasuper.com` (`:3210`), `convex-site.ollasuper.com` (`:3211`) via the VM's existing
  named tunnel. `deploy/56-discover-tunnel.sh` (read-only) → `57-ollasuper-domain.sh` (ingress + origins +
  rebuild, touches no DNS) → `58-ollasuper-dns.sh` (the flip, dry-run by default). Replaces the ephemeral
  `*.trycloudflare.com` URLs, which change on `cloudflared` restart and require an app rebuild.
  Two things to know: taking over `app.ollasuper.com` displaces the product currently there (rollback is
  recorded to `/opt/myos/.dns-rollback.json` before the change), and moving `CONVEX_SITE_ORIGIN` moves the
  OIDC issuer, so **every existing session is invalidated** and all users are signed out once.
  Universal SSL covers the root plus first-level subdomains, so all three hostnames get a valid free cert.
  Unverified until `56` runs: that `networkershome.com` and `ollasuper.com` share one Cloudflare account —
  a single tunnel can only span zones within one account.
- **Email — local option DONE (Mailpit), or Resend for real delivery.** Auth emails now send
  over SMTP via a Node action (`convex/email.ts` + `nodemailer`); set `SMTP_HOST`/`SMTP_PORT`
  (+ optional `SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`). Pointed at self-hosted **Mailpit**
  (`deploy/50-mailpit.sh`, SMTP `:1025`, web inbox `:8025`) and verified a signup email lands.
  The code is still logged as a fallback, so log-mode keeps working when SMTP is unset. For
  real outbound mail, set `SMTP_*` to Resend's SMTP (or any provider) — no code change.
- **Google OAuth** — add `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` + register the callback. **Unblocked** once
  the domain scripts above run: exposing `:3211` as `convex-site.ollasuper.com` gives the stable, real-cert
  redirect URI this was waiting on. Enabling it is deliberately NOT part of that change.
- **Strong `INSTANCE_SECRET`** for the Convex backend (currently the compose default) before any real use.
- **Observability — DONE via self-hosted GlitchTip** (no external SaaS). `self-hosted/glitchtip/`
  brings up a Sentry-protocol-compatible stack; the app's existing `@sentry/nextjs` wiring reports
  to it by setting `NEXT_PUBLIC_SENTRY_DSN` to the GlitchTip DSN. Verified end-to-end on the VM
  (injected error stored as an `IssueEvent`). Trace sampling defaults to 10%
  (`NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`). For a real deployment, set GlitchTip `ALLOWED_HOSTS`.
  (Sentry SaaS still works too — just use its DSN instead.)
- **Verify `deploy/setup.sh` on a clean VM** — the one-command clone install is written but never run end-to-end.

## 3. Audit backlog (low severity)
- **BUG-6** — strip/gate internal seed/test functions (`*ForUser`, `seed:firstUserId`, `record`, `inviteForUser`) behind a `DEV_SEED` flag, and treat `backend-echo` as reference-only, for real deployments. (They're `internal*`, not publicly callable — cleanup, not a vuln.)
- **BUG-8** — pagination (see Dashboard UX above).

## Performance (from the read-amplification audit)
Profiled with `convex/seed.ts` (DEV_SEED-gated load generators + profilers) on a
seeded 8k-job / 5k-notification workspace:
- **Fixed:** `notifications.unreadCount` read **5001 rows** (collect-all) → now **10**
  (indexed `by_user_read` + `take(10)`; the bell only needs 0..9 / "9+"). O(10) at any scale.
- **FIXED:** counting a workspace no longer scans every row. A `counters` table is maintained via
  `bump()` in `files.saveFile`/`remove`, member add/remove, and `chat/threads`/`chat/messages`,
  so a count is O(#metrics) instead of O(workspace size). Drift-guarded by a unit test
  (create/delete→counts) and backfilled for existing data (`counters:backfillAll`). The
  `dashboard.stats` query this originally served was removed with the Dashboard section (see 0),
  but the counters remain and the chat/files paths still depend on them. (`orgs.members` still does N+1 `ctx.db.get` per
  row; `myWorkspaces` now issues them in parallel via `Promise.all`. Fine at team
  sizes; revisit only if memberships grow large.)

## AI chat (`/chat`) — the inference plane
The AI half the template left as a seam (`TEMPLATE.md:3`) is now built, as a **hybrid**:
Convex stays the data plane; a separate **Python FastAPI + LangGraph** service at
`services/ai/` is the inference plane, talking to OpenRouter.

- **Streaming is Convex-mediated.** The browser never talks to Python. Python POSTs token
  batches to `/ai/ingress`; the browser's `useQuery` subscription re-renders. That is what
  makes a stream survive a refresh, work in a second tab, and need no SSE on the client.
- **The in-flight message row is written exactly twice** — `""` on insert and the final text
  on finalize — because Convex re-sends a whole query result on any write. Deltas live in
  `chatStreamChunks` and are compacted every 24 seqs. `chat.stream.active` is the only query
  that re-fires during a generation.
- **Chat is private to the USER**, not the workspace — unlike every other table here, where
  any member reads any row. `workspaceId` is for tenancy only. There is deliberately **no
  workspace-only index** on `chatThreads`/`chatMessages`, so no query shape in this codebase
  can enumerate a tenant's conversations without pinning a `userId` first.
- **Ports:** the service binds `127.0.0.1:8770`. Not 8000 — `deploy/47-glitchtip.sh` tunnels
  `localhost:8000` to a public `trycloudflare` URL, and binding there would publish it.
- **Secrets:** `AI_SERVICE_KEY` (Convex→Python) and `AI_INGRESS_SECRET` (Python→Convex) are
  distinct from `BACKEND_WEBHOOK_SECRET`, which belongs to `backend-echo` in a different trust
  domain. `OPENROUTER_API_KEY` is never generated, never defaulted, and never written by a
  deploy script — `services/ai/.env` (0600) only.
- **Ingress is capability-scoped, not just secret-gated:** every op carries a `streamId` UUID
  minted inside `messages.send`, and `/ai/file` additionally requires the blob to belong to
  that stream's own thread. A leaked ingress secret still cannot reach an arbitrary
  conversation or an arbitrary blob.
- **Spend controls:** ≤60 messages + a rolling summary from Convex, a 32k-token trim on prior
  turns, a 48k-char cap on the newest turn, 3 concurrent streams and 120 generations/hour per
  user. Without the last two, `send → stop → retry` is an unbounded billing loop.
- **Run the tests:** `bun test` (72 Convex tests incl. cross-user isolation) and
  `cd services/ai && uv run pytest` (35, no network / no Convex / no API key needed).
- **Deferred, by design:** RAG and tools. The schema and the LangGraph edge layout leave room
  for both (`add_conditional_edges("model", tools_condition, …)` needs no change to the
  streaming path, because the writer already filters on `langgraph_node == "model"`).

## Notes / caveats
- **Convex Cloud is now the production source of truth (2026-08-18).** The whole
  deployment moved (1121 rows, 30 tables, 0 storage blobs); ids were preserved so
  all 16 `v.id("users")` foreign keys resolved with zero dangling refs. Proven by
  a real signup landing on Cloud (users 26->27) while self-hosted stayed at 26.
  Self-hosted is kept as a rollback; `deploy/57-ollasuper-domain.sh` now refuses
  to repoint the app back unless `FORCE_CONVEX_URL=1`.
  Outstanding: Google redirect URI for `*.convex.site` must be registered, and
  a real mail transport must be configured. RESOLVED 2026-09-01: Ollastack Agent Mail is
  the outbound transport for both auth codes and scheduled reports (see the Ollastack entry
  under Done). Resend was never configured and its branch has been removed.
- **Backups did not exist on the rebuilt VM (fixed 2026-08-18).** `/opt/backups` was absent,
  no cron was installed, there was no log, and `deploy/backup.sh` was not executable — so
  production had no recovery point at all, despite "nightly backup" being listed under Done.
  The cron is installed by `deploy/29-fixes.sh`, which was never run during the rebuild of
  `172.16.70.25`. That script must NOT be re-run to fix it: it opens with `cp /tmp/orgs.ts …`
  and runs without `set -e`, so on a VM lacking those staged files it fails the copies,
  continues anyway, and then deploys whatever is on disk. `deploy/61-backups.sh` now does the
  backup half idempotently.
  `backup.sh` itself also gained `--include-file-storage` (without it, archives held rows whose
  avatar/file/attachment blobs were absent) and now verifies the new archive exists and is
  non-trivial **before** pruning, so a failed export can no longer delete the last good one.
- **Convex Cloud is a dev/staging target, not production.** `deploy/60-convex-cloud-dev.sh`
  points a build at any Cloud deployment; it refuses a non-empty one unless `ALLOW_NONEMPTY=1`.
  A production cutover is blocked on three things, none of them config:
  (a) Cloud actions cannot reach `AI_BASE_URL`/`BACKEND_BASE_URL` on private addresses;
  (b) `POLAR_ORGANIZATION_TOKEN`/`POLAR_WEBHOOK_SECRET` are required in `convex/env.ts` but set
  by no script; (c) Polar’s `customers` join table is component state that `convex export` does
  not cover and has no upstream source. Moving also re-registers the Google redirect URI and
  invalidates every session.
- **OPEN P0 — chat generation is down on the production VM.** Convex actions call the inference
  plane at `AI_BASE_URL=http://127.0.0.1:8770`, but Convex runs **in Docker** (`self-hosted_default`,
  gateway `172.18.0.1`) while `myos-ai` binds host loopback only. A process bound to `127.0.0.1` is
  unreachable from another network namespace, so every generation fails with
  `Connection refused (os error 111)` and the assistant row lands in `error`. The service itself is
  healthy (`/healthz` and `/readyz` both 200 **from the host**).
  This is the same class of bug as the SMTP-at-container-loopback issue fixed earlier.
  Not caught by e2e because `p-chat`'s reply assertion is `body.innerText.includes("PONG")`, which
  matches the user's own echoed message — so the step passes with no reply. It is also the real
  cause of the two long-standing `p-chat` failures (`scroll-to-bottom pill`, `stop generation`):
  with no generated text the transcript never overflows and no Stop button ever appears.
  Fix (not applied — it widens a bind on live production, so it wants a decision):
  bind uvicorn to `0.0.0.0` in `deploy/54-ai-service.sh` and add
  `ufw allow from 172.18.0.0/16 to any port 8770 proto tcp`. ufw is active and currently allows only
  22/tcp, so net exposure stays effectively loopback-equivalent. Tighten the e2e assertion at the
  same time so this cannot regress silently again.
- ~~Email is **log-fallback** until Resend is configured.~~ RESOLVED 2026-09-01: auth codes
  and scheduled reports both go out over Ollastack Agent Mail. Before that, production was
  worse than log-fallback: SMTP pointed at the local Mailpit catcher, so codes reached
  neither a logfile nor a person.
- `NEXT_PUBLIC_CONVEX_URL` is baked in at **build** time, so any change of Convex hostname needs a full
  `next build` — restarting the service is not enough, and a stale `.next` will keep serving the old origin.
  `deploy/57-ollasuper-domain.sh` clears `.next` before rebuilding and then greps the output to prove the new
  origin is actually in the bundle. This is also why the old ephemeral `trycloudflare` URLs were painful: they
  changed on every `cloudflared` restart and each change required a rebuild.

## Long-running / Ollagraph-heavy execution — what the perf work left open

The throughput + deadline work (see `perf(agent):` commits) removed the artificial
step / fan-out / tool-discovery ceilings and fixed the frozen deadline. These were
measured on production during that work and deliberately NOT fixed in it.

- **`dispatch_unreachable` is the largest error class (101 all-time)** — bigger than
  `internal` (58) and `deadline_exceeded` (13). It is Convex failing to reach the
  inference plane at dispatch. It is NOT explained by the service dying: `NRestarts=0`
  and zero OOM kills over the 14 days examined. Nobody has looked at what it actually
  is, and it dwarfs the timeout problem that prompted the perf work.
- **`model_stream_fallback` fires ~480×/14d.** Ollima streams tool-call deltas in a
  shape langchain's accumulator rejects, so the graph re-issues the whole call against
  the non-streaming twin — a SECOND full model call, at roughly 10% of model calls.
  The recovery is correct; the cost is not accounted for anywhere.
- **`record_execution` is still one un-batched ingress round-trip per state change**
  (two per tool call, ~126ms of measured loopback each). Typed events were coalesced;
  executions were not, because the RUNNING write is the write-ahead a side-effecting
  tool must clear before it may fire. A read-only tool's execution rows carry no such
  constraint and could ride the same batching — that is where the next chunk of
  fan-out latency lives.
- **Residual Convex OCC is now sourced at `heartbeat` / `appendDeltas`**, not
  `appendEvent` (which was 68/68 before and is ~2/14 after). Lower volume and a
  different shape; not investigated.
- **`qa-seo-audit.js` tests a capability that is not in this codebase.** It waits for
  `[aria-label="SEO audit report"]`, which only the durable SEO-run subsystem renders.
  `AI_SEO_RUNS_ENABLED=true` on the VM, but `seoRuns`/`seoRunSteps`/`seoArtifacts` do
  not exist in `packages/backend/convex` at all, and `seo_run_enqueue/finalize/report`
  exist ONLY as definitions in `app/clients/convex.py` with no caller anywhere. So the
  suite reports 3/5 permanently while the audit itself completes correctly (measured:
  168s, 40+ real SEO tool calls, `status: done`, and the Deep Research suite's own SEO
  regression step passes). Either wire the subsystem or retarget the assertion — as it
  stands it is a standing red that trains people to ignore it.
- **`qa-blog-verify.js` asserts model PROSE** ("Blog Quality Score", a `NN → NN`
  progression). The same config scored 6/8 and 8/8 on consecutive runs, so the suite
  cannot distinguish a real regression from output variance at n=1. Anything load-
  bearing that it guards needs either a deterministic signal or replicate runs.
