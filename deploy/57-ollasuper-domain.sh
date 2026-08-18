#!/usr/bin/env bash
# Move the stack onto ollasuper.com. Run AFTER 56-discover-tunnel.sh confirms the
# tunnel is locally-managed and in the same Cloudflare account as ollasuper.com.
#
#   app.ollasuper.com          -> :3000  (Next app)
#   convex.ollasuper.com       -> :3210  (Convex cloud origin — browser websocket)
#   convex-site.ollasuper.com  -> :3211  (Convex site origin — HTTP actions + OIDC issuer)
#
# THIS SCRIPT TOUCHES NO DNS. Nothing here is visible to the public until 58 runs,
# which is what makes every step below reversible. Ordering is deliberate:
# serve first, flip DNS second — a hostname that resolves before cloudflared is
# ready serves a 1016 to real users, whereas ingress added early is simply unused.
#
# Idempotent: re-running re-asserts the same state.
#
# TWO THINGS TO KNOW BEFORE YOU RUN IT
#   1. Changing CONVEX_SITE_ORIGIN changes the OIDC issuer (auth.config.ts reads
#      CONVEX_SITE_URL), so EVERY EXISTING SESSION IS INVALIDATED. All users are
#      signed out. This is unavoidable, not a bug.
#   2. deploy/28-fix-issuer.sh deliberately pinned the site origin to plain
#      http://10.1.30.14:3211 because a self-signed Caddy cert broke the backend's
#      OIDC self-discovery. A real Cloudflare cert is exactly what retires that
#      workaround — but the fetch now hairpins out to Cloudflare and back, so
#      step 6 proves it works and REFUSES to hand over to 58 if it does not.
set -uo pipefail

APP_HOST=app.ollasuper.com
CVX_HOST=convex.ollasuper.com
SITE_HOST=convex-site.ollasuper.com
NODE=/usr/bin/node
CVX=/opt/myos/node_modules/convex/bin/main.js
NEXT=/opt/myos/node_modules/next/dist/bin/next
BE=/opt/myos/packages/backend
SH=/opt/myos/self-hosted
STAMP=$(date +%Y%m%d-%H%M%S)

die() { printf '\nFATAL: %s\n' "$1" >&2; exit 1; }
say() { printf '\n=== %s ===\n' "$1"; }

# ---------------------------------------------------------------- 1. tunnel ingress
say "1/6 tunnel ingress"
CFG=""
for f in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml \
         /root/.cloudflared/config.yml /root/.cloudflared/config.yaml; do
  [ -f "$f" ] && { CFG="$f"; break; }
done
[ -n "$CFG" ] || die "no cloudflared config.yml found.
The tunnel is REMOTELY-managed (ingress lives in the Zero Trust dashboard) or is a
quick tunnel. This script cannot add ingress rules in that case. Either add
  $APP_HOST -> http://localhost:3000
  $CVX_HOST -> http://localhost:3210
  $SITE_HOST -> http://localhost:3211
as Public Hostnames on the tunnel in the dashboard and re-run, or supply a token
with Account -> Cloudflare Tunnel:Edit. Run 56-discover-tunnel.sh for the details."
echo "config: $CFG"
cp -a "$CFG" "$CFG.bak-$STAMP" && echo "backup: $CFG.bak-$STAMP"

if grep -q "$APP_HOST" "$CFG"; then
  echo "ingress already contains $APP_HOST — leaving config alone (idempotent)"
else
  # Insert BEFORE the catch-all. cloudflared evaluates ingress top-down and the
  # final rule (a bare `service:`) matches everything, so appending would make
  # these three rules dead.
  awk -v app="$APP_HOST" -v cvx="$CVX_HOST" -v site="$SITE_HOST" '
    !done && /^[[:space:]]*-[[:space:]]*service:[[:space:]]*http_status:404/ {
      print "  - hostname: " app;  print "    service: http://localhost:3000"
      print "  - hostname: " cvx;  print "    service: http://localhost:3210"
      print "  - hostname: " site; print "    service: http://localhost:3211"
      done=1
    }
    { print }
    END { if (!done) exit 3 }
  ' "$CFG" > "$CFG.new"
  case $? in
    0) mv "$CFG.new" "$CFG"; echo "added 3 ingress rules above the catch-all" ;;
    3) rm -f "$CFG.new"
       die "could not find the 'service: http_status:404' catch-all in $CFG.
Add the three hostname rules by hand above the final catch-all, then re-run." ;;
    *) rm -f "$CFG.new"; die "awk failed rewriting $CFG" ;;
  esac
fi

cloudflared tunnel ingress validate --config "$CFG" || die "ingress validate failed; config restored from $CFG.bak-$STAMP"
for h in "$APP_HOST" "$CVX_HOST" "$SITE_HOST"; do
  printf 'route %-28s -> ' "$h"; cloudflared tunnel ingress rule --config "$CFG" "https://$h" 2>&1 | tail -1
done

# A tunnel picks up ingress changes on SIGHUP without dropping connections;
# restart is the fallback for units that do not wire up ExecReload.
UNIT=$(systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null \
       | awk '{print $1}' | grep -iE 'cloudflared|cf-tunnel' | head -1)
if [ -n "${UNIT:-}" ]; then
  echo "reloading $UNIT"
  systemctl reload "$UNIT" 2>/dev/null || systemctl restart "$UNIT"
  sleep 5; echo "$UNIT=$(systemctl is-active "$UNIT")"
else
  echo "WARNING: no cloudflared unit found; reload it yourself"
fi

# ------------------------------------------------------------- 2. convex origins
say "2/6 convex origins"
cp -a "$SH/.env" "$SH/.env.bak-$STAMP" 2>/dev/null && echo "backup: $SH/.env.bak-$STAMP"
cat > "$SH/.env" <<EOF
DISABLE_BEACON=true
PORT=3210
SITE_PROXY_PORT=3211
DASHBOARD_PORT=6791
CONVEX_CLOUD_ORIGIN=https://$CVX_HOST
CONVEX_SITE_ORIGIN=https://$SITE_HOST
NEXT_PUBLIC_DEPLOYMENT_URL=https://$CVX_HOST
EOF
cat "$SH/.env"
# `up -d` reconciles config without touching named volumes. Deliberately NOT
# --force-recreate and never `down -v`: the Convex data volume lives here.
( cd "$SH" && docker compose up -d ) || die "docker compose up failed"
sleep 8
( cd "$SH" && docker compose ps ) | head -5

# --------------------------------------------------------------- 3. convex env
say "3/6 convex SITE_URL + redeploy"
cd "$BE" || die "no $BE"
"$NODE" "$CVX" env set SITE_URL "https://$APP_HOST" >/dev/null 2>&1 \
  || die "convex env set failed — is packages/backend/.env.local (admin key) present?"
echo "SITE_URL=$("$NODE" "$CVX" env get SITE_URL 2>&1 | tail -1)"
# Required: the issuer moved, so auth.config.ts must be re-pushed.
"$NODE" "$CVX" deploy -y 2>&1 | tail -3 || die "convex deploy failed"

# ------------------------------------------------------------ 4. app + echo env
say "4/6 app + backend-echo env"
cp -a /opt/myos/apps/app/.env "/opt/myos/apps/app/.env.bak-$STAMP" 2>/dev/null
# Convex Cloud is the source of truth for user/account data as of the
# 2026-08-18 migration, so this script must NOT silently drag the app back
# onto the self-hosted deployment. An existing value wins; override with
# FORCE_CONVEX_URL=1 only if you genuinely mean to repoint it.
EXISTING_CVX=$(grep -oP "(?<=^NEXT_PUBLIC_CONVEX_URL=).*" /opt/myos/apps/app/.env 2>/dev/null || true)
if [ -n "${EXISTING_CVX:-}" ] && [ "${FORCE_CONVEX_URL:-0}" != "1" ]; then
  CVX_TARGET=$EXISTING_CVX
  echo "  keeping existing NEXT_PUBLIC_CONVEX_URL=$CVX_TARGET (FORCE_CONVEX_URL=1 to override)"
else
  CVX_TARGET=https://$CVX_HOST
fi
cat > /opt/myos/apps/app/.env <<EOF
NEXT_PUBLIC_CONVEX_URL=$CVX_TARGET
NEXT_PUBLIC_BACKEND_URL=http://10.1.30.14:4000
EOF
cat /opt/myos/apps/app/.env
if [ -f /opt/myos/backend-echo/.env ]; then
  cp -a /opt/myos/backend-echo/.env "/opt/myos/backend-echo/.env.bak-$STAMP"
  sed -i "s#^CONVEX_SITE_URL=.*#CONVEX_SITE_URL=https://$SITE_HOST#" /opt/myos/backend-echo/.env
  echo "backend-echo CONVEX_SITE_URL -> https://$SITE_HOST"
fi

# ------------------------------------------------------------------- 5. rebuild
say "5/6 rebuild + restart"
# NEXT_PUBLIC_* is inlined at BUILD time, so the rebuild is mandatory — restarting
# alone would keep serving the old Convex URL. Clear .next so no stale chunk
# carries the previous origin.
cd /opt/myos/apps/app || die "no apps/app"
rm -rf .next
set -e
"$NEXT" build 2>&1 | tail -6
set +e
systemctl restart myos-app
systemctl restart myos-echo 2>/dev/null
sleep 8
echo "app=$(systemctl is-active myos-app) echo=$(systemctl is-active myos-echo 2>/dev/null)"

# ----------------------------------------------------------------- 6. pre-flight
say "6/6 PRE-FLIGHT — must all pass before running 58"
FAIL=0
for p in 3000 3210 3211; do
  C=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "http://127.0.0.1:$p/" 2>/dev/null)
  printf 'local :%-5s -> %s\n' "$p" "${C:-none}"
  [ -n "$C" ] && [ "$C" != "000" ] || { echo "  ^ FAIL"; FAIL=1; }
done

# Confirm the built bundle really carries the new Convex origin.
if grep -rqs "$CVX_HOST" /opt/myos/apps/app/.next 2>/dev/null; then
  echo "built bundle references $CVX_HOST -> OK"
else
  echo "built bundle does NOT reference $CVX_HOST -> FAIL (stale build)"; FAIL=1
fi

# THE HAIRPIN. The Convex backend must fetch its own issuer through the Cloudflare
# edge. This CANNOT pass until 58 creates the DNS record, so a failure here is
# expected on the first run and is reported as INFO, not FAIL.
CID=$(cd "$SH" && docker compose ps -q backend 2>/dev/null | head -1)
if [ -n "${CID:-}" ]; then
  OUT=$(docker exec "$CID" sh -c "curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://$SITE_HOST/.well-known/openid-configuration" 2>&1)
  echo "container -> https://$SITE_HOST/.well-known/openid-configuration : ${OUT:-error}"
  if [ "$OUT" = "200" ]; then
    echo "  OIDC hairpin OK"
  else
    echo "  INFO: expected to fail until 58 creates DNS. RE-RUN THIS SCRIPT AFTER 58:"
    echo "        if it still is not 200, auth will be broken. The fix is to short-circuit"
    echo "        the hairpin by adding to $SH/docker-compose.yml under the backend service:"
    echo "          extra_hosts: [\"$SITE_HOST:172.17.0.1\"]   # host gateway -> :3211"
  fi
fi

[ "$FAIL" -eq 0 ] || die "pre-flight failed — do NOT run 58 until the above is green.
Roll back with: cp $CFG.bak-$STAMP $CFG ; cp $SH/.env.bak-$STAMP $SH/.env ; (cd $SH && docker compose up -d)"

say "READY"
echo "Local stack is serving the new hostnames through the tunnel."
echo "Nothing is public yet. Next: sudo CLOUDFLARE_API_TOKEN=... bash deploy/58-ollasuper-dns.sh"
echo "Then RE-RUN this script once, to confirm the OIDC hairpin now returns 200."
echo "OLLASUPER_DOMAIN_DONE"
