# Roadmap

Deferred work, captured so it isn't lost. Ordered roughly by priority.

## ✅ Done (current state)
Self-hosted Convex (Docker) · multi-tenant backend (workspaces/RBAC/invites) · hybrid backend adapter (proxy / JWKS-direct / webhook) · usage · API keys · audit · events · files · **AI chat at `/chat`** (Convex data plane + Python inference plane → OpenRouter; real streaming, folders, search, attachments, prompt library — see the AI chat section below) · **full auth** (email+password, mandatory email verification, password reset, magic OTP, Google provider [creds pending], password policy, brute-force lockout 5/hr) · real HTTPS via Cloudflare tunnel · **left sidebar shell** + reactive workspace switcher + responsive drawer · **toasts + confirm dialogs** · CI (typecheck+lint) + branch protection · nightly backup.

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
- **Polish** — loading skeletons, consistent empty states, 404 page + error boundary, footer/version, help/docs link, keyboard shortcuts. Remove dead `_components/navigation.tsx` (old top-nav, no longer imported).

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
- Email is **log-fallback** until Resend is configured (codes appear in Convex logs).
- `NEXT_PUBLIC_CONVEX_URL` is baked in at **build** time, so any change of Convex hostname needs a full
  `next build` — restarting the service is not enough, and a stale `.next` will keep serving the old origin.
  `deploy/57-ollasuper-domain.sh` clears `.next` before rebuilding and then greps the output to prove the new
  origin is actually in the bundle. This is also why the old ephemeral `trycloudflare` URLs were painful: they
  changed on every `cloudflared` restart and each change required a rebuild.
