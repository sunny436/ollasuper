# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**myos** — a self-hosted, multi-tenant SaaS control-plane forked from `get-convex/v1`, plus an AI chat product built on top of it. It is **live in production** on a VM at `172.16.70.25` (Convex `:3210`/`:3211`, Next `:3000`, backend-echo `:4000`, dashboard `:6791`), publicly tunnelled at `app.ollasuper.com`. Treat pushes to it accordingly.

The browser opens a WebSocket to Convex directly, and it reaches it **through the app's own hostname** on the path form — `app.ollasuper.com/__cvx` → `:3210`, `/__cvx-site` → `:3211` — which is what `NEXT_PUBLIC_CONVEX_URL` is set to. This works because `edge/proxy.js:68` installs an `upgrade` handler (its own comment: *"load-bearing: the Convex browser client is a WSS"*) and path routing is matched before host routing. An earlier version of this file claimed the WebSocket "cannot ride on the app's hostname" — that is **wrong**, and it was wrong in a costly direction, because it implies Cloudflare Tunnel and DNS work that is not needed. The host form (`convex.ollasuper.com`, `convex-site.ollasuper.com`) is the optional clean alternative: DNS for both already resolves, but neither is a Public Hostname on the tunnel, so both currently return **404** while `/__cvx` returns 200.

`ollasuper.com` itself is **not ours** — the apex, `www` and `tokens.` serve other properties (a marketing site and a design-token site on Cloudflare Pages), and the zone carries live MX/SPF/DKIM/DMARC mail records. Anything touching DNS must operate on an allowlist of our three hostnames; `deploy/58-ollasuper-dns.sh` does, and diffs the whole zone afterwards to prove nothing else moved.

`TEMPLATE.md` describes the original seam: the control-plane is the platform plumbing (auth, orgs, files, billing), and "your product/AI logic lives in a separate backend." The AI half is now built — see **Two planes** below.

The dashboard, devices, sessions, AI-access, jobs and platform sections were removed; `/` redirects to `/chat`. The remaining surfaces are **Chat**, **Files**, **Settings** and **Billing**. Tenancy, RBAC, API keys, usage, audit and events survived the removal as backend-only modules — they lost their Platform UI, not their function.

## Where the data lives (PostgreSQL since 2026-08-18)

**PostgreSQL 16 on the VM is the persistent database.** Self-hosted Convex runs
with `--db postgres-v5` against database `convex_self_hosted`, so every Convex
function, auth flow, subscription, scheduler and the whole frontend are unchanged
— only the storage engine moved. Convex Cloud (`benevolent-koala-651`) is left
running and untouched as the rollback of record.

Read this before touching any of it:

- **Convex does NOT map its tables to SQL tables.** `\dt` shows exactly five
  relations — `documents · indexes · leases · persistence_globals · read_only` —
  and all 25 logical tables live as rows inside `documents`. That is correct, not
  a failed migration. Your data is **not** queryable as relational SQL.
- **Not everything is in PostgreSQL.** Without the six `S3_STORAGE_*` vars,
  `run_backend.sh` passes `--local-storage`, so compiled **modules**, **text
  search indexes**, exports and snapshot-import staging stay on the docker volume
  (`storage/{modules,search,exports,files,snapshot_imports}`). PostgreSQL holds
  tables, documents, index data, scheduler and cron state.
- **`POSTGRES_URL` must carry `?sslmode=disable`** (despite upstream saying "no
  query params"). `DO_NOT_REQUIRE_SSL` makes TLS *optional*, not *unverified*:
  the driver still prefers TLS and dies with `invalid peer certificate:
  UnknownIssuer` against this host's snakeoil cert, which carries only
  `DNS:ollasuper-vm` and no IP SAN, so connecting by IP can never validate.
- **The backend does not create its own database.** It connects straight to the
  name derived from `INSTANCE_NAME` (`-`→`_`) and exits `FATAL: database ... does
  not exist`. `CREATEDB` on the role is not enough; pre-create it.
- **MIGRATION ORDER IS LOAD-BEARING: import BEFORE deploy, then restart.**
  `--replace-all` replaces module *metadata* in the SQL store, but module *blobs*
  live in local file storage and no snapshot restores them. Deploying first leaves
  `couldn't open .../modules/<uuid>.blob` and a permanently failing
  `reap stalled chat streams` cron; a later deploy re-uploads blobs but does not
  rebind existing crons.
- **The compose network subnet is pinned** to `172.18.0.0/16` in
  `docker-compose.override.yml` because `deploy/62-convex-postgres.sh` scopes one
  `pg_hba` line and one `ufw` rule to it. `ufw`'s INPUT policy is DROP, so a
  mismatch presents as a **hang**, not an error.
- **`listen_addresses` must be `*`, never the bridge gateway.** PostgreSQL binds
  its sockets once at startup and boots *before* Docker creates the bridge, so
  naming the gateway fails with `could not bind IPv4 address "172.18.0.1":
  Cannot assign requested address`; Postgres then serves loopback only and the
  backend restart-loops on `Connection refused (os error 111)`. Docker also
  renames the interface across reboots (`br-6c73df06e774` → `br-4a4201efea2e`),
  so a named interface is racy by construction. Only a **reboot test** catches
  this — it is invisible whenever the bridge already happens to exist. Exposure
  stays closed by ufw plus pg_hba, not by the bind address.
- The backend image is pinned **by digest** — a silently newer backend could
  migrate the persistence layout of a live database on an unattended restart.
- The admin key is `f(INSTANCE_NAME, INSTANCE_SECRET)`, both persisted in the
  volume's `credentials/`, so it survives the storage swap unchanged.
- `db.sqlite3` is renamed to `db.sqlite3.disabled-proof` on the volume. Leave it
  that way: if `POSTGRES_URL` ever goes missing, `run_backend.sh` silently falls
  back to SQLite, and an absent file makes that failure obvious instead of
  serving stale pre-migration data.

Scripts: `deploy/62-convex-postgres.sh` (Postgres prep), `63-convex-pg-cutover.sh`
(data), `64-convex-pg-app-cutover.sh` (app repoint). All idempotent.

### Historical note — the Cloud migration this replaced

`users` could not be moved on its own: `Id<T>` is deployment-scoped, 16
`v.id("users")` foreign keys span the schema, `upsertUserAndAccount` writes
`users`+`authAccounts` in one transaction, and `getAuthUserId` is a bare cast on
the JWT `sub` with no DB lookup — so a split fails *silently*, not loudly. The
whole deployment therefore moved together, and the same held moving back.

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
cd apps/app && NEXT_PUBLIC_CONVEX_URL=http://172.16.70.25:3210 bun run build
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

The browser never talks to Python. Python posts token batches to Convex — the hot ops (delta / event / heartbeat / finalize) through the guarded public mutation `chat/ingress:apply` over `/api/mutation` (~10 ms; the same secret check and capability-scoped mutations as the HTTP action), everything else through `POST /ai/ingress` (an HTTP action, ~136 ms of which ~125 ms is runtime overhead — measured) — and the browser's `useQuery` subscription re-renders. That is what makes a stream survive a refresh, work in a second tab, and need no SSE on the client. Python serialises its posts per stream (`writer._wire`): three concurrent writers on one `chatStreams` row cost 86 OCC retries a day.

The design turns on one fact: **Convex re-sends the whole query result to every subscriber on any write, with no document-level diffing.** Therefore:

- The in-flight assistant row is written **exactly twice** — `""` on insert, final text on finalize. It is never patched during streaming. `chat.messages.listPaged` excludes in-flight rows and stays stable during a generation.
- Deltas are append-only rows in `chatStreamChunks`, compacted into `chatStreams.committedText` every 24 seqs.
- `chat.stream.active` is the **only** query that re-fires per delta. It is small **by construction**: the resident chunks (those above `committedSeq`) plus `committedSeq` and `hasEvents` — never the whole answer, never the events. The client accumulates the text itself (`chat/_lib/stream-text.ts`); it asks `chat.stream.committed` for the compacted prefix only while it is missing it (a mid-stream mount, reload or reconnect) and then drops that subscription; typed events ride `chat.stream.events`, which re-fires on append, not per delta. Returning `committedText` from `active` again would make the wire quadratic in the answer length (measured: ~1.7 MB for a p99 answer).
- `TOOL_RESULT.content` (the model-context block, 74 % of all bytes in `chatMessages` on production) exists for durable resume, which reads the live `chatStreamEvents` row. Every DISPLAY copy — the fold at finalize, `toPublic`, `stream.events` — goes through `stripForDisplay`; the browser never rendered it.
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
- **`rehype-raw` is deliberately not installed.** Raw HTML in a model response is never parsed into nodes, so XSS safety is by construction rather than by filtering. If it is ever added, `rehype-sanitize` becomes mandatory. Invariant: `rg dangerouslySetInnerHTML` over the chat directory returns exactly ONE match — `_components/mermaid.tsx` — plus the comment explaining why. That one is the sanctioned exception: mermaid renders SVG from its own diagram DSL with `securityLevel:"strict"` (labels escaped, no event handlers, no click-through), so it never passes model-authored HTML through. `remark-math`+`rehype-katex` are also present but need no `dangerouslySetInnerHTML` — katex builds React/hast nodes from the parsed math, not from raw HTML.
- **`convex` is pinned to exactly `1.19.2`** in all four `package.json` files. A caret range lets bun silently re-resolve to 1.44 under a self-hosted 1.19 server. No Convex components beyond `polar` — changing the component tree on a live self-hosted backend is the highest-risk push category.
- **Biome, not ESLint/Prettier.** Run `biome lint`, not `biome check --write` — the latter reformats pre-existing files and produces a diff full of unrelated churn.
- **Never pass `budget_tokens` or `temperature` to Claude 5-series models** — they reject non-default sampling params with a 400. `services/ai/app/agent/llm.py` sets `temperature=None` for this reason.
- **New Convex tables must be additive.** The live deployment has pre-migration rows; a required field on an existing table fails schema validation on push.
- `/chat` lives in the **`(workspace)` route group**, not `(dashboard)` — it is full-bleed and renders neither the app sidebar nor the topbar. Route groups do not affect URLs. The routes that kept the dashboard shell (`/files`, `/settings`, `/settings/billing`) are reachable from the account menu at the foot of the conversation rail, which is their ONLY route out of the workspace.
- Chat UI uses `.h-dvh-safe` (in `packages/ui/src/globals.css`), not `h-screen` — Tailwind cannot express the `vh`/`dvh` fallback pair and `tailwind-merge` collapses it. There is no accent hue any more (see **The monochrome system** below); `--brand`/`--brand-ink` are pure ink and `--brand-foreground` its inverse, and the three-token split is kept only so ~170 existing call sites still work.
- **`.workspace` in `globals.css` re-points the existing surface tokens** (`--card`, `--border`, `--background` …) for the chat subtree, so components re-skin without className churn. Radix portals mount outside it — any portalled surface needs `className="workspace"` or it renders against the base palette.
- New functionality is written in **Python** (LangChain / LangGraph / Pydantic / FastAPI) unless it is inherently Convex data-plane work. This is a standing repo policy.

### The monochrome system (2026-09-18)

Pure white `#FFFFFF` and pitch black `#000000`, one neutral grayscale between
them, and **no gradients, glass, glow or WebGL anywhere**. The continuous
day→amber→dusk→night "ambience" engine that used to drive every token at runtime
is gone; the tokens in `globals.css` are literals again.

- The frontend speaks only `ThemeMode = "light" | "dark"` (`lib/theme/mode.ts`).
  The legacy `chatSettings.ambience` 0-100 number survives in exactly ONE
  adapter, `lib/theme/legacy-ambience.ts`. Nothing else may reference it.
- Precedence is `explicit account preference > localStorage cache > OS > light`.
  localStorage is a **cache**, never a source of truth; a fresh local choice
  beats a stale server one by timestamp, and an unreachable backend keeps the
  local theme rather than flipping it.
- **`15` and `null` both mean "no preference."** 53 of the 97 production rows sat
  at exactly `15` — the old engine's `DEFAULT_INTENSITY`, auto-written whenever
  the server value was null and the user never touched the slider. Mapping
  "0-49 → light" would have pinned 55% of accounts to light against their OS
  setting. No row is rewritten until the user actually toggles.
- Colour survives in exactly three places, all deliberate: **status** (error /
  warning / success, as text, icons and 1px borders — never a fill), **content**
  (shiki, `--chart-*`, mermaid — five series in one greyscale ramp cannot be told
  apart), and **third-party identity marks** (the Google and Microsoft logos are
  trademarks whose brand terms require their colourways).
- Elevation is a 1px border for inline surfaces and ONE subtle shadow for
  overlays. `shadow-lg/xl/2xl` are banned, and so is `hover:brightness-*` —
  brightness on pure black is a no-op, so it silently removes the hover state.
- Two tests defend this and they are not redundant: `monochrome.test.ts` reads
  `globals.css` and greps the source; `e2e/qa-monochrome.js` walks every route in
  both themes in a real browser, which is the only way to see computed colour,
  pseudo-elements and third-party CSS.

### Accent colour (2026-09-18)

Blue · Green · Yellow · Pink · Orange · Purple · Neutral, default Blue, at Settings →
Appearance. It is **the `--brand` trio re-pointed**, nothing more — the same three
variables the monochrome system left at pure ink still drive ~162 brand-* utilities.

- **`--accent` is NOT the accent colour.** That token predates this feature and is the
  neutral hover surface behind `hover:bg-accent`. The accent colour is `data-accent` on
  `<html>` plus `--brand` / `--brand-ink` / `--brand-foreground`. They collide only in
  English.
- **`--primary` is NOT the accent either**, and must never become it: it is the body ink
  behind ~494 `text-primary*` usages. The shadcn `<Button>` default variant was moved
  from `bg-primary` to `bg-brand` for exactly this reason — one line, 14 consumers.
- **An accent is an enum, never a colour string.** The only value reaching the DOM is
  one of seven literals; every colour lives in `globals.css`. The server re-validates
  on write against its OWN copy of the list — a server that imports its allowlist
  from the client is not validating anything.
- **Selectors key on the bare attribute** (`[data-accent="x"]`, and `.dark [data-accent]`
  for descendants), not `:root[data-accent]`. `<html>` sets the page accent; a nested
  element can scope the palette to itself, which is how the picker swatches paint
  their own colours with no colour in the component. The `:root`-scoped version
  shipped first and made every swatch the same colour.
- **Blue is written twice on purpose**: `:root`/`.dark` as the no-attribute fallback,
  `[data-accent="blue"]` as the opt-in. A test pins them identical.
- Three tokens because they do three jobs; every value was solved against three
  contrast pairs (on-fill, on-page, on a 10% tint) at ≥ 4.5:1 in both modes, and
  `monochrome.test.ts` re-checks all 42. **Yellow takes black on-fill text** — the only
  yellow dark enough to carry white is a brown.
- Not accented, deliberately: `--ring`, status colours, `--chart-*`, the OllaSuper mark
  (renders from `text-foreground`).
- **The user bubble IS accented** (`bg-brand` / `text-brand-foreground`), by operator
  decision, overriding an earlier audit that kept it `bg-muted`. Consequence stated
  plainly: **under Neutral the bubble is a solid black (light) / white (dark) slab** —
  the exact look the monochrome work removed. So "Neutral" restores the monochrome
  *tokens* exactly, but not the previous *visual*: the bubble differs. Long turns clamp
  at 12 lines (`max-h-[20.4em]`) with a `mask-image` fade and a "Show more" control at
  full-strength on-fill ink — never at reduced opacity, which put white on blue at
  3.9:1. The clamp re-measures through a `ResizeObserver`; a mount-only measurement
  went stale the moment the rail collapsed or the window resized.
- Persistence is **per user per workspace** (`chatSettings` `by_user_workspace`), the
  same as light/dark. `qa-monochrome.js` pins Neutral so the greyscale guarantee stays
  provable on a real page; `qa-accent.js` covers the rest.

### Branding (2026-09-18)

One mark, one wordmark, one component — `src/components/branding/`.

- **The mark is the supplied artwork, verbatim.** `olla-super-mark.source.svg` is
  committed unmodified beside the component; nothing imports it. It exists so
  "matches the logo exactly" is something `branding.test.ts` CHECKS — the
  component path, the favicon path and the source path must be identical
  character for character. Do not rescale it to a rounder viewBox: that trades
  fidelity for tidiness, and an earlier reconstructed-by-eye mark already shipped
  wrong once. Only two attributes were changed from the source, and only because
  they had to be: `fill`/`stroke` `#020201` became `currentColor`. The 0.25 stroke
  stays — the six subpaths abut, and without it antialiasing shows hairlines.
- **`<OllaSuperBrand variant="auth" | "app" />` is the only brand component.**
  The app variant swaps mark for wordmark in pure CSS at `md`. The wordmark is
  `sr-only md:not-sr-only`, NOT `hidden md:block` — below `md` the text is
  visually gone but stays in the accessibility tree, so the mark-only view keeps
  its name from the same node, announced exactly once at every size.
- **`currentColor` CANNOT be used in `app/icon.svg`.** A favicon renders outside
  any document, so it resolves to the SVG's own `color` — black — and vanishes in
  dark browser chrome. The file carries its own `prefers-color-scheme` block.
  Verified by loading `/icon.svg` as a top-level document in both schemes.
- **`/apple-icon` has no file extension**, so the middleware matcher (which exempts
  `*.svg/png/…`) let it reach the auth gate; it needs an explicit bypass or every
  signed-out fetch 302s to `/login`.
- **The share `og:image` is locale-prefixed.** next-international hides the locale,
  but Next builds metadata URLs from the route path — which lives under
  `[locale]` — so the emitted URL is `/en/share/<token>/opengraph-image-…`. That
  path needs its own public matcher, and must NOT go through `I18nMiddleware`.
  Without it the card renders perfectly and no scraper can ever fetch it.
- Email templates render their own italic uppercase wordmark and are deliberately
  out of this system: email supports neither Poppins, nor SVG, nor `currentColor`.
  `"myos.session.displaced"` is a localStorage key, not branding.

### Typography (2026-09-18)

**Poppins is the one UI face.** There is no per-component font work anywhere:
Tailwind preflight puts `theme(fontFamily.sans)` on `<html>` and
`font-family: inherit` on every form control, so the `sans` entry in
`packages/ui/tailwind.config.ts` IS the app. `font-brand` (the wordmark) is the
same face at 800.

- Loaded once, in `app/[locale]/layout.tsx`, via `next/font/google`: weights
  400 / 500 / 600 / 700 / 800 (the census of the source; 800 is the wordmark),
  upright **and italic** (markdown emits `<em>`; a family with no italic face is
  fake-slanted, and `next/font/google` only takes the weight × style product).
  Self-hosted under `/_next/static/media/`; zero requests to Google.
- **`subsets` decides what is preloaded, not what exists.** The one call declares
  the Devanagari and Latin-Extended faces too, each behind a `unicode-range`, so
  Hindi renders in Poppins and an English page never downloads them. **Do not add
  a second `Poppins()` call** for the other scripts: it re-declares the same
  faces at un-preloaded duplicate URLs and the browser can fetch both copies.
- Three renderers cannot inherit and are handled by hand: **Sonner** injects its
  own `font-family` at runtime, unlayered — the override in `globals.css` is
  outside every `@layer` and one specificity step up (`html [data-sonner-toaster]`)
  so source order cannot matter; **Chart.js** draws on a canvas, which has no
  cascade — `"inherit"` is an invalid canvas font and silently left labels at
  `10px sans-serif`, so it is handed the resolved `<html>` stack; **mermaid**'s
  `fontFamily: "inherit"` is fine and is verified at runtime.
- Monospace survives on exactly the code surfaces (`font-geist-mono` ×6) and two
  identifier surfaces (`font-mono` on OAuth scopes and capability ids). Code
  LABELS ("PYTHON"), the 404 and error headings are UI and are Poppins.
  `lib/theme/font.test.ts` pins that allowlist by file and count — anything
  new that names a font fails with its path — and `e2e/qa-font.js` reads the
  platform font every glyph was drawn with (CDP), which is the only proof that
  survives a third-party stylesheet.
- Named limits: the OPEN popup of a native `<select>`/date/time input is OS-drawn;
  the OG image is Satori with its own bundled font; email is out of scope.

### Freshness, evidence and rendered verification (2026-09-19)

The 18.09.2026 skill audit found a "last 30 days" question answered from a
two-year-old source, live search skipped, a deck lost to two opaque schema
errors, a doughnut delivered as a pie, and files called correct because
generation succeeded. What was true in the code: no date anchor in the prompt,
no temporal parsing, no source dating, search failures silent on simple turns,
`"Invalid file specification."` with no field, `donut` accepted but `doughnut`
rejected while the inline-chart guidance teaches `doughnut`, no page numbers or
TOC in the renderers, and a preview the model never sees.

- **`app/agent/freshness.py` is the deterministic half of freshness.** The
  request's temporal requirement is parsed from the user's own words (`strict`
  with a cutoff — "last 30 days", "this week", "since 1 Sep"; `live` without one
  — "latest price", "what changed"); bare "now"/"currently" are not triggers,
  and a sentence about this conversation or an attached file is not a
  requirement. `today` is the UTC date and is in the system prompt on both
  branches. Search results have NO date field — the engine puts one at the START
  of the snippet; scraped pages carry a dateline in their markdown. Dates are
  ranked (`published > updated > snippet > inferred > reported`); **an unknown
  date never satisfies a strict window.** Under a strict window, explicitly
  stale results are moved out of `results` into `excluded_stale` with the reason.
- **Retrieval is initiated by code (R3).** A turn with a requirement runs ONE
  search in the `approvedPending` seam before the first model step, injected as a
  real tool round (`call_id: freshness_prefetch`); not on a resume, where
  `completedTools` is counted instead. The search provider has no recency
  filter; the month/year in the query is the only lever.
- **`runtime/notices.py` renders ONE end-of-turn block**, in a fixed order, from
  recorded state: requirement ledger → retrieval/freshness (no search ran /
  provider failed / stale citation named with its date / no source inside the
  window) → research coverage (uncovered or single-non-primary-source
  sub-questions, a domain heuristic; one primary source is enough) →
  traceability (a cited URL never retrieved this turn, zero links after
  retrieval, dangling `[n]`, numeric tables with no source nearby) → claim
  correction → truncation. Never author these in the model.
- **Documents: one chart vocabulary.** `filegen/spec.py::normalize_chart` maps
  `doughnut→donut` and the Chart.js shape onto `labels/series`; anything it
  would have to guess at is an ERROR that names the field (`slides.0.chart:
  unsupported chart type 'radar'…`). An empty chart in a slide/section is an
  error, not a blank picture; a SHEET chart may plot its rows. `page_numbers`
  and `toc` render a real TOC (reportlab `multiBuild` + outline; DOCX gets a
  static TOC from a LibreOffice pass, or a field when soffice is off).
  `filegen/verify.py` checks the RENDERED file — outline vs TOC, `Page X of Y`,
  blank pages on faithful rasters only — and `_run_generate_file` returns a
  `verification` block, repairs once (an empty page break), and refuses a
  known-invalid file rather than attach it. Uploaded images cannot be embedded;
  the skill says so.
- **The VM needs `libreoffice-writer` as well as `-impress`.** Impress alone was
  installed for decks; DOCX→PDF failed silently (`source file could not be
  loaded`) until Writer was added on 19-09 (`apt-get install -y
  --no-install-recommends libreoffice-writer`). A rebuilt VM must install both.

## Cost controls (do not remove)

Unbounded context is the default failure mode of a chat product. Four layers, all deliberate:

1. Convex sends ≤60 messages + a rolling summary (`buildHistory`).
2. `trim_messages` against a **32k**-token budget — not the model's 1M window. A full 1M context is ~$5.00 per message at Opus-5 input rates.
3. `ai_max_turn_chars` (48k) bounds the *newest* turn, shared across all its documents. The history budget does not cover it, and the newest turn is where all the user-controlled bulk is.
4. `MAX_GENERATIONS_PER_HOUR` (120) per user. `MAX_CONCURRENT_STREAMS` bounds *parallel* generations only — `send → stop → retry` never runs more than one stream and is otherwise an unbounded billing loop.

The **system prompt** is budgeted separately and is not covered by (2): built-in skill guidance is capped at `ai_skill_instructions_budget_chars` (20k) and user-authored skills at `ai_user_skill_budget_chars` (6k, a deliberately separate budget so a user's skill cannot evict a built-in's constraints). Both are measured into `system_tokens` before history is trimmed, so they shrink the history window rather than overrunning the model's — but they are ~6.5k tokens of input on every turn that activates them, and that is real money at Opus rates.

## Ports

The AI service binds `127.0.0.1:8770`, **not 8000** — `deploy/47-glitchtip.sh` runs a cloudflared tunnel from a public `trycloudflare` URL to `localhost:8000`, and whichever process binds first wins.

## Deployment

`deploy/` is 62 numbered, idempotent shell scripts run in order on the VM; `deploy/54-ai-service.sh` is the AI service. `OPENROUTER_API_KEY` is never generated, never defaulted and never written by a script — an operator fills it into `services/ai/.env` (0600), and the script hard-fails until they do. It lives in **exactly one place**: the inference plane, which is the only thing that needs it to call a model. `convex/chat/models.ts` deliberately fetches the *unauthenticated* `/api/v1/models` (identical payload, no credentials) so the catalogue never becomes a second copy of the secret.

### DEPLOY ORDER IS LOAD-BEARING: Python → Convex → frontend

`GenerateRequest` (`services/ai/app/models/chat.py`) is `extra="forbid"`, and `dispatchPayload` sends every field it knows about **unconditionally**. So the moment Convex starts sending a field a running Python build does not declare, **every** `POST /v1/generate` fails validation — and `chat.stream.dispatch` treats any non-2xx as terminal. That is not degraded chat, it is **no chat, for every user, immediately**.

Therefore, whenever a change adds a field to the dispatch payload:

1. **Python first.** Deploy `services/ai`, restart it, confirm it is serving.
2. **Then Convex.** `convex deploy` — only now does the new field start travelling.
3. **Then the frontend.** `NEXT_PUBLIC_CONVEX_URL` is build-time, so a UI change needs `rm -rf .next` + a full rebuild; a restart alone does nothing.

Rolling **back** runs the same order in reverse: revert Convex before Python, or the old Convex will be talking to a Python build that has already lost the field. Fields added this way so far: `personalization`, `customSkills`.

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

## HARD ENGINEERING GUARDRAILS — NON-NEGOTIABLE

- Never claim DONE without actual verification evidence.
- For user-facing production changes, headed Chrome + real-user testing on the deployed production app is the final acceptance gate.
- Unit tests, API tests, mocks, and DB checks are supporting evidence only.
- If production verification fails, the task is NOT DONE. Fix → redeploy → retest.
- Never fake success, progress, Ready, test results, or suppress failures.
- Always write a minimum-safe code plan before implementation.
- The plan must contain only changes necessary to satisfy the requirement. No unnecessary refactoring, abstraction, dependency, infrastructure, or architecture changes.
- Do not spend tokens/time explaining obvious things or generating unnecessary plans. First inspect the existing code, identify the real root cause, then propose the smallest safe solution.
- Do not implement speculative fixes. Measure/investigate first when the bottleneck or root cause is uncertain.
- Never modify working code just for "cleanup" during an unrelated task.
- Never introduce Redis/Kafka/Celery/new services/databases/etc. unless evidence proves they are required.
- For performance work: measure → identify bottleneck → minimum change → measure again.
- For bugs: reproduce → diagnose root cause → minimum-safe fix → regression test → production verification.
- Test the complete requirement, not only the happy path or easiest scenario.
- Use realistic user behavior and realistic/large inputs when applicable.
- For security/multi-tenant features, test both authorized and unauthorized access with real accounts where applicable.
- If something is not verified, explicitly say Verification pending. Never imply it works.
- Before declaring DONE, provide concrete evidence of what was implemented and what was actually verified.

### STRICT COMPLETION RULE

Implementation complete ≠ Task complete.

A task becomes DONE only after the required verification passes.

Do not optimize for producing more code or more explanation. Optimize for the smallest correct change and the strongest proof that it works.
