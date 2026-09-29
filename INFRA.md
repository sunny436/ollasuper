# INFRA.md — ground truth for the OllaSuper production box

> Purpose: this file records **how production actually runs**, verified live, so
> nobody breaks it next time. Where this file and older docs disagree, **this file
> is right** — it was written against the running machine, not from memory.
> (Hinglish note: jo cheez jaisi chal rahi hai, waisi hi chalti rahe — pehle yeh
> padho, phir haath lagao.)

_Last verified: 2026-08-19 against the live VM._

---

## 0. Golden rules (read before touching anything)

1. **Production is the VM at `172.16.70.25`** (hostname `ollasuper-vm`). It serves
   `app.ollasuper.com`. **`10.1.30.14` is NOT production** — it is a separate,
   older, still-running box that is *not* behind the tunnel and that we have no
   SSH access to. Leave it alone; never deploy to it.
2. **Env vars are inlined at BUILD time.** Changing `apps/app/.env` and restarting
   `myos-app` does **nothing**. You must `rm -rf apps/app/.next` and rebuild.
3. **The VM cannot reach GitHub.** You cannot `git pull` on it. Deploy by pushing
   to its local bare repo over SSH (see §6).
4. **Two Convex URLs, on purpose** (see §5). The browser uses the public
   `app.ollasuper.com/__cvx`; the server uses loopback `127.0.0.1:3210`. Never
   swap them — a loopback URL in the client bundle breaks every browser; the
   public URL on the server sends every request on a 95 ms round trip to itself.
5. **Do not touch the live box's config, Convex/Postgres data, the tunnel, or
   `/root/.ssh` casually.** Deploys change only the app source + `.next`.

---

## 1. Production box

| | |
|---|---|
| IP | **172.16.70.25** (LAN) |
| Hostname | `ollasuper-vm` |
| OS | Ubuntu 24.04 |
| SSH | `ssh root@172.16.70.25` (key-only, no password) |
| App root | `/opt/myos` · edge proxy at `/opt/myos-edge` · bare repo `/opt/myos.git` |
| Public URL | `https://app.ollasuper.com` via Cloudflare Tunnel |
| Interfaces | `172.16.70.25`, plus docker bridges `172.17.0.1` / `172.18.0.1` |

**SSH keys:** this workstation's key (`claude-code@DESKTOP-PKO1Q8C`) is authorized
in `/root/.ssh/authorized_keys` (17 keys total). A separate `ollasuper-offsite-backup`
key runs the *other* direction (VM → workstation for backups). The file was backed
up to `/root/.ssh/authorized_keys.safe-*` before any edit.

### The other box — `10.1.30.14`
Still alive, serves the **same app stack** (`:3000` Next, `:3210` Convex, `:6791`
dashboard) on a **different, older build**, but is **not** behind the
`app.ollasuper.com` tunnel and we have **no SSH** to it. Treat as unmanaged/legacy.
Do not confuse it with prod. All repo references to it were scrubbed (PR #21).

---

## 2. Network topology

```
Browser ──HTTPS──▶ Cloudflare ──Tunnel(token)──▶ cloudflared (on VM)
                                                     │  forwards app.ollasuper.com ─▶ 127.0.0.1:5150
                                                     ▼
                                          edge proxy  (/opt/myos-edge, node, :5150)
                                          ├─ path /__cvx/*      ─▶ 127.0.0.1:3210  (Convex API)
                                          ├─ path /__cvx-site/* ─▶ 127.0.0.1:3211  (Convex HTTP/site)
                                          └─ everything else     ─▶ 127.0.0.1:3000  (Next.js)
```

- The tunnel is **token-managed** (`cloudflared … tunnel run --token …`); its
  ingress is configured in the Cloudflare Zero Trust dashboard, **not** on the VM.
- The edge proxy's `upgrade` handler is **load-bearing** — the Convex browser
  client is a WebSocket; a proxy that only handled `request` would break streaming.
- Path routing wins over host routing, which is why Convex rides the app hostname.

---

## 3. Ports (all bound on the VM)

| Port | Process | What |
|---|---|---|
| 3000 | `next-server` | Next.js app (`myos-app`) |
| 3210 | docker-proxy | Convex API (self-hosted backend) |
| 3211 | docker-proxy | Convex HTTP/site actions |
| 6791 | docker-proxy | Convex dashboard |
| 5150 | node | edge proxy (`myos-edge`) — tunnel terminates here |
| 8770 | python | AI inference plane (`myos-ai`, FastAPI) — **loopback only** |
| 5432 | postgres | PostgreSQL 16 (Convex's persistent store) |
| 1025 / 8025 | docker-proxy | Mailpit SMTP / web UI |
| 20241 | cloudflared | cloudflared metrics/management |
| 53 | systemd-resolve | local DNS |
| 22 | sshd | SSH |

Note: **backend-echo (`:4000`) is not running** despite older doc mentions. The AI
plane binds `127.0.0.1:8770` specifically (not `:8000`) to avoid a glitchtip tunnel
clash.

---

## 4. Services & containers

**systemd (running):** `myos-app`, `myos-ai`, `myos-edge`, `cloudflared`,
`docker`, `postgresql@16-main`. `myos-web` exists but is **inactive** (not used).

**docker containers:** `self-hosted-backend-1` (Convex, healthy),
`self-hosted-dashboard-1` (Convex dashboard), `mailpit` (dev mail, healthy).

- Convex runs **self-hosted on PostgreSQL** (`--db postgres-v5`, database
  `convex_self_hosted`, `INSTANCE_NAME=convex-self-hosted`). All 25 logical tables
  live as rows inside the SQL `documents` table — that's correct, not a failed
  migration.
- Compiled modules / search indexes / exports stay on the docker volume
  (`--local-storage`), not in Postgres.

---

## 5. The two Convex URLs (do not swap)

| Var | Value | Used by | Why |
|---|---|---|---|
| `NEXT_PUBLIC_CONVEX_URL` | `https://app.ollasuper.com/__cvx` | **browser** (build-time inlined) | The browser must reach Convex over the public hostname/WSS. |
| `CONVEX_SERVER_URL` | `http://127.0.0.1:3210` | **Next server / middleware** | The server runs ON the VM; using the public URL sent every auth check out to Cloudflare and back (95 ms → 1 ms fix). Falls back to `NEXT_PUBLIC_CONVEX_URL` if unset, so dev/CI are unaffected. |

`middleware.ts` reads `CONVEX_SERVER_URL`. `deploy/68-perf-server-convex-url.sh`
sets it and hard-fails if a `127.0.0.1` URL ever leaks into the **client** bundle.

---

## 6. How to deploy (the only correct way)

The VM can't reach GitHub, and env vars are build-time. From this workstation:

```bash
# 1. push the merged commit to the VM's LOCAL bare repo (must be a fast-forward)
git push "ssh://root@172.16.70.25/opt/myos.git" <sha-or-branch>:refs/heads/main

# 2. on the VM: reset the checkout to it (secrets are gitignored, untouched)
ssh root@172.16.70.25 'cd /opt/myos && git fetch origin && git reset --hard origin/main'

# 3. on the VM: rebuild + restart (build-time inlining — a restart alone is a no-op)
ssh root@172.16.70.25 'cd /opt/myos && export BUN=/root/.bun/bin/bun && bash deploy/68-perf-server-convex-url.sh'
```

`deploy/68` is idempotent: verifies Convex answers on loopback, backs up `.env`,
`rm -rf .next`, `bun run build`, `systemctl restart myos-app`, then self-checks
(Sentry absent, no loopback URL in client, public URL baked). It prints
`PERF_CUTOVER_DONE` on success. **`bun` is at `/root/.bun/bin/bun`**, not on PATH.

- Only `myos-app` restarts on a normal deploy. The Convex/Postgres stack and the
  tunnel are **not** touched — the app is briefly down only during the rebuild window.
- Run `bun install --frozen-lockfile` first if `package.json`/`bun.lock` changed.

---

## 7. Secrets (gitignored — live only on the VM)

`apps/app/.env` · `self-hosted/.env` · `services/ai/.env` ·
`packages/backend/.env.local` · `apps/app/.env.pre-cloud` (rollback snapshot) ·
`/root/.cvx-cloud-key` (Convex Cloud deploy key, 0600). `OPENROUTER_API_KEY` lives
only in `services/ai/.env`. Never commit any of these.

---

## 8. Backups & rollback

Snapshots taken during the perf deploy (on the VM, under `/root/`):
- `next-prod-backup-20260819-082903/` — the pre-perf production build
  (**deleted 2026-09-29** to free 782 MB; many deploys old, no longer a
  usable rollback)
- `app-env-backup-20260819-082903` — pre-perf `apps/app/.env`
- `myos-uncommitted-20260819-082903.patch` — the working-tree state that existed before cleanup
- `authorized_keys.safe-20260819-083341` — pre-edit SSH keys

`deploy/68` also writes `apps/app/.env.bak-<stamp>` each run.

**Rollback a bad deploy:** restore `apps/app/.env.bak-<stamp>`, `rm -rf .next`,
rebuild, `systemctl restart myos-app` — or `git reset --hard <good-sha>` then
rebuild. Pre-migration DB snapshot: `/opt/backups`.

---

## 9. Known traps (things that already bit us — don't repeat)

- **`/login → /chat` redirect in middleware breaks login.** The App Router follows
  a middleware redirect on an RSC refresh for data but never commits the URL, so the
  browser fetches `/chat` and sits on `/login` forever. Post-login navigation is
  done explicitly in `auth-panel.tsx` (`router.replace("/chat")`); the middleware
  keeps its original `/login → /` target.
- **Build-time inlining** (§0.2) — the #1 "why didn't my change take effect".
- **`set -euo pipefail` + `grep` in verification** — a `grep` that finds nothing
  exits 1 and aborts the script; the "is Sentry gone?" success case does exactly
  that. Guard such greps with `|| true` (fixed in `deploy/68`).
- **Postgres bind / subnet pin** — `listen_addresses` must be `*` (Postgres boots
  before the docker bridge; naming the gateway fails). The compose network is
  pinned to `172.18.0.0/16` because `pg_hba`/`ufw` scope to it. Only a reboot test
  catches a regression here.
- **`packages/backend/.env.local` overrides `CONVEX_DEPLOY_KEY`** — any Cloud CLI
  command must pass `--env-file` at an empty file or it silently acts on self-hosted.

---

## 10. Measuring performance

`e2e/p-perf.js` is the harness (plain Playwright, asserts zero console errors, so it
doubles as a smoke test). It logs in, does cold `/` and `/chat` runs, and reports
TTFB, DCL, rail/composer times, JS bytes, and main-thread blocking as medians.

```bash
cd e2e && bun install
E2E_BASE_URL=https://app.ollasuper.com node p-perf.js --label after --runs 7
```

Jitter-free server-side auth-path check (run on the VM): compare
`curl http://127.0.0.1:3210/version` (loopback, ~1 ms) vs
`curl https://app.ollasuper.com/__cvx/version` (the old path, ~95 ms).
