# Roadmap

Deferred work, captured so it isn't lost. Ordered roughly by priority.

## ✅ Done (current state)
Self-hosted Convex (Docker) · multi-tenant backend (workspaces/RBAC/invites) · hybrid backend adapter (proxy / JWKS-direct / webhook) · usage · API keys · audit · events · files · **AI chat at `/chat`** (Convex data plane + Python inference plane → OpenRouter; real streaming, search, attachments — see the AI chat section below) · **full auth** (email+password, mandatory email verification, password reset, magic OTP, Google provider [creds pending], password policy, brute-force lockout 5/hr) · real HTTPS via Cloudflare tunnel · **left sidebar shell** + reactive workspace switcher + responsive drawer · **toasts + confirm dialogs** · CI (typecheck+lint) + branch protection · nightly backup (**see the backup entry under Notes — this was listed as done but had never actually run on the current VM**).

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
- **Command palette (⌘K)** (cmdk) + **notifications center** (needs a `notifications` table + functions + bell UI).
- **Pagination / load-more** on files / audit / events (closes audit **BUG-8**; queries currently `take(50)` / unbounded `.collect()`).
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
  but the counters remain and the chat/files paths still depend on them. (`orgs.members`/
  `myWorkspaces` still do N+1 `ctx.db.get` per row — fine at team sizes; revisit only if
  memberships grow large.)

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
  `RESEND_API_KEY` must be set so auth codes stop being written to logs.
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
- Email is **log-fallback** until Resend is configured (codes appear in Convex logs).
- `NEXT_PUBLIC_CONVEX_URL` is baked in at **build** time, so any change of Convex hostname needs a full
  `next build` — restarting the service is not enough, and a stale `.next` will keep serving the old origin.
  `deploy/57-ollasuper-domain.sh` clears `.next` before rebuilding and then greps the output to prove the new
  origin is actually in the bundle. This is also why the old ephemeral `trycloudflare` URLs were painful: they
  changed on every `cloudflared` restart and each change required a rebuild.
