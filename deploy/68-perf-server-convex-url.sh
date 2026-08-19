#!/usr/bin/env bash
# 68-perf-server-convex-url.sh — point SERVER-side Convex calls at the loopback
# backend, then rebuild the app so the navigation perf work takes effect.
#
# WHY THIS EXISTS
#
# NEXT_PUBLIC_CONVEX_URL is https://app.ollasuper.com/__cvx. That is correct for
# the browser and wrong for the Next server, which runs on THIS VM: every
# middleware auth check was leaving the box, crossing Cloudflare, coming back
# down the tunnel through cloudflared and edge/proxy.js, and arriving at
# 127.0.0.1:3210 — a process one hop away on loopback.
#
# Measured on production before the change (n=8, median TTFB):
#     unauth /chat  (no auth call, no SSR)  109 ms
#     authed /login (auth call, no SSR)     158 ms   <- +49 ms, the round trip
#     authed /chat  (auth call + chat SSR)  190 ms
# and it is paid on every document load AND every RSC client-side navigation.
#
# src/middleware.ts reads CONVEX_SERVER_URL and falls back to
# NEXT_PUBLIC_CONVEX_URL when it is unset, so local dev, CI and any non-VM
# deployment keep working with nothing set. This script sets it on the VM.
#
# BUILD-TIME, NOT RUNTIME. Next inlines these values into the edge bundle at
# build time, so a service restart alone does nothing — .next must be removed
# and the app rebuilt. That is the same trap CLAUDE.md documents for
# NEXT_PUBLIC_CONVEX_URL.
#
# Idempotent: safe to re-run.
set -euo pipefail

REPO=${REPO:-/opt/myos}
APP=$REPO/apps/app
BUN=${BUN:-/root/.bun/bin/bun}
SERVER_CONVEX_URL=${SERVER_CONVEX_URL:-http://127.0.0.1:3210}
STAMP=$(date +%Y%m%d-%H%M%S)

say() { printf '  %s\n' "$*"; }
set_kv() {  # file key value  — '#' delimiter because values contain '/' and ':'
  local f="$1" k="$2" v="$3"
  if grep -qE "^$k=" "$f"; then sed -i "s#^$k=.*#$k=$v#" "$f"; else printf '%s=%s\n' "$k" "$v" >> "$f"; fi
}

echo "=== 68-perf-server-convex-url ==="

echo "--- 1. the loopback backend must actually answer before we point at it ---"
curl -fsS --max-time 5 "$SERVER_CONVEX_URL/version" >/dev/null 2>&1 \
  || { echo "FATAL: no Convex backend at $SERVER_CONVEX_URL — refusing to write a URL that does not resolve" >&2; exit 1; }
say "backend reachable at $SERVER_CONVEX_URL"

echo "--- 2. apps/app/.env ---"
cp -a "$APP/.env" "$APP/.env.bak-$STAMP"
set_kv "$APP/.env" CONVEX_SERVER_URL "$SERVER_CONVEX_URL"
say "CONVEX_SERVER_URL=$SERVER_CONVEX_URL   (backup: .env.bak-$STAMP)"
say "NEXT_PUBLIC_CONVEX_URL=$(grep -E '^NEXT_PUBLIC_CONVEX_URL=' "$APP/.env" | cut -d= -f2-)  (unchanged — the browser still needs the public form)"

echo "--- 3. rebuild (build-time inlining: a restart alone would be a no-op) ---"
cd "$APP"
rm -rf .next
$BUN run build 2>&1 | tail -20 | sed 's/^/  /'

echo "--- 4. restart ---"
systemctl restart myos-app.service
for i in $(seq 1 60); do curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3000/login && break; sleep 1; done
say "myos-app: $(systemctl is-active myos-app.service)"

echo "--- 5. verify ---"
say "local /login  -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3000/login)  (expect 200)"
say "local /       -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3000/)       (expect 307)"
say "public /login -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://app.ollasuper.com/login)  (expect 200)"

# The Sentry SDK is no longer bundled unless NEXT_PUBLIC_SENTRY_DSN is set
# (next.config.mjs). Prove it, because it was 317KB raw / 93KB gzip — 31% of the
# /chat bundle — being shipped to every visitor for nothing.
DSN=$(grep -E '^NEXT_PUBLIC_SENTRY_DSN=' "$APP/.env" | cut -d= -f2- || true)
if [ -z "$DSN" ]; then
  FIRSTLOAD=$(grep -rl "@sentry/nextjs\|sentryWrapped" .next/static/chunks/*.js 2>/dev/null | wc -l)
  say "NEXT_PUBLIC_SENTRY_DSN empty; sentry-bearing client chunks: $FIRSTLOAD (global-error only is expected)"
else
  say "NEXT_PUBLIC_SENTRY_DSN set — Sentry intentionally bundled"
fi

# The public URL must still be what the browser gets baked in, or the websocket
# breaks. 64-convex-pg-app-cutover.sh checks the same thing for the same reason.
BAKED=$(grep -rhoE "https://[a-z0-9.-]+\.convex\.cloud|https://app\.ollasuper\.com/__cvx" .next/static 2>/dev/null | sort -u | tr '\n' ' ')
say "baked into the client bundle: ${BAKED:-none}"
case "$BAKED" in
  *127.0.0.1*) echo "FATAL: a loopback URL reached the CLIENT bundle — the browser cannot use it" >&2; exit 1;;
esac

echo "PERF_CUTOVER_DONE"
