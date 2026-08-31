#!/usr/bin/env bash
# 64-convex-pg-app-cutover.sh — point the app at self-hosted-on-PostgreSQL.
#
# Run AFTER 63-convex-pg-cutover.sh has the data in place and healthy.
#
# NO CLOUDFLARE OR DNS WORK IS REQUIRED, contrary to the first draft of the plan.
# edge/proxy.js routes BOTH ways simultaneously:
#   * PATH  /__cvx -> :3210, /__cvx-site -> :3211   on the app hostname
#   * HOST  convex[-site].ollasuper.com             needs Zero Trust dashboard entries
# Its own comments settle it: the `upgrade` handler at proxy.js:68 is "load-bearing:
# the Convex browser client is a WSS", and "Path routing wins so it works on the app
# hostname." Measured: https://app.ollasuper.com/__cvx returns 502 with the backend
# down (route live) while https://convex.ollasuper.com returns 404 (no tunnel route).
# So the PATH form is used — which is also exactly what .env.pre-cloud held, i.e. the
# configuration that was in production before the Cloud migration.
#
# CONVEX_SITE_ORIGIN feeds CONVEX_SITE_URL, which auth.config.ts uses as the JWT
# issuer, so it must be the PUBLIC site origin, not a loopback address.
set -euo pipefail

REPO=${REPO:-/opt/myos}
SH=$REPO/self-hosted
APP=$REPO/apps/app
# bun is NOT on the PATH of a non-interactive ssh shell (it lives under /root/.bun),
# which is exactly how myos-app.service invokes it too. Use the absolute path.
BUN=${BUN:-/root/.bun/bin/bun}
CLOUD_ORIGIN=${CLOUD_ORIGIN:-https://app.ollasuper.com/__cvx}
SITE_ORIGIN=${SITE_ORIGIN:-https://app.ollasuper.com/__cvx-site}
STAMP=$(date +%Y%m%d-%H%M%S)

say() { printf '  %s\n' "$*"; }
set_kv() {  # file key value  — '#' delimiter because values contain '/' and ':'
  local f="$1" k="$2" v="$3"
  if grep -qE "^$k=" "$f"; then sed -i "s#^$k=.*#$k=$v#" "$f"; else printf '%s=%s\n' "$k" "$v" >> "$f"; fi
}

echo "=== 64-convex-pg-app-cutover ==="

echo "--- 1. sanity: the self-hosted backend must be healthy first ---"
curl -fsS --max-time 5 http://127.0.0.1:3210/version >/dev/null 2>&1 \
  || { echo "FATAL: backend not responding on :3210 — run 63 first" >&2; exit 1; }
DOCS=$(sudo -u postgres psql -tAc "select count(*) from documents" convex_self_hosted)
say "backend up; documents in PostgreSQL: $DOCS"
[ "$DOCS" -gt 100 ] || { echo "FATAL: only $DOCS documents — the import did not land" >&2; exit 1; }

echo "--- 2. public origins for the backend (JWT issuer depends on the site one) ---"
cp -a "$SH/.env" "$SH/.env.bak-$STAMP"
set_kv "$SH/.env" CONVEX_CLOUD_ORIGIN "$CLOUD_ORIGIN"
set_kv "$SH/.env" CONVEX_SITE_ORIGIN  "$SITE_ORIGIN"
chmod 600 "$SH/.env"
say "CONVEX_CLOUD_ORIGIN=$CLOUD_ORIGIN"
say "CONVEX_SITE_ORIGIN=$SITE_ORIGIN"

echo "--- 3. recreate the backend so it picks the new origins up ---"
cd "$SH"
docker compose up -d 2>&1 | tail -4 | sed 's/^/  /'
for i in $(seq 1 90); do curl -fsS --max-time 3 http://127.0.0.1:3210/version >/dev/null 2>&1 && break; sleep 1; done
say "backend: $(docker inspect self-hosted-backend-1 --format '{{.State.Status}}')"

echo "--- 4. confirm the public path routes reach it (200/4xx, no longer 502) ---"
for p in /__cvx/version /__cvx-site; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "https://app.ollasuper.com$p" || echo ERR)
  say "https://app.ollasuper.com$p -> $code"
done

echo "--- 5. repoint the app (NEXT_PUBLIC_CONVEX_URL is BUILD-TIME inlined) ---"
cp -a "$APP/.env" "$APP/.env.bak-$STAMP"
set_kv "$APP/.env" NEXT_PUBLIC_CONVEX_URL "$CLOUD_ORIGIN"
say "apps/app/.env: $(grep '^NEXT_PUBLIC_CONVEX_URL=' "$APP/.env")"

echo "--- 6. full rebuild (a restart alone would keep the old URL in the bundle) ---"
cd "$APP"
rm -rf .next
# .next/types can hold stale route stubs that fail the build; removing .next covers it.
[ -x "$BUN" ] || { echo "FATAL: bun not executable at $BUN" >&2; exit 1; }
if ! NEXT_PUBLIC_CONVEX_URL="$CLOUD_ORIGIN" timeout 1800 "$BUN" run build 2>&1 | tail -18 | sed 's/^/  /'; then
  echo "FATAL: build failed. The app is still serving the OLD bundle (pointing at Cloud)," >&2
  echo "       so production is unchanged. Fix the build, then re-run." >&2
  exit 1
fi

echo "--- 7. verify the new URL is actually baked into the bundle ---"
BAKED=$(grep -rhoE "https://[a-z0-9.-]+\.convex\.cloud|https://app\.ollasuper\.com/__cvx" .next/static 2>/dev/null | sort -u | tr '\n' ' ')
say "URLs in bundle: ${BAKED:-<none found>}"
if printf '%s' "$BAKED" | grep -q "convex.cloud"; then
  echo "WARNING: a *.convex.cloud URL is still present in the bundle." >&2
fi

echo "--- 8. restart the app ---"
systemctl restart myos-app
for i in $(seq 1 60); do
  curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null && break
  sleep 1
done
say "myos-app: $(systemctl is-active myos-app)"
say "public: $(curl -s -o /dev/null -w '%{http_code}' --max-time 12 https://app.ollasuper.com/login || echo ERR)"

echo
echo "64-convex-pg-app-cutover: DONE"
echo "  ROLLBACK: set NEXT_PUBLIC_CONVEX_URL back to the Cloud URL in apps/app/.env,"
echo "            rm -rf .next, rebuild, systemctl restart myos-app. Cloud is untouched."
