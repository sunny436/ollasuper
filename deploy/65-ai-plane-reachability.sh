#!/usr/bin/env bash
# 65-ai-plane-reachability.sh — let the Convex backend reach the Python AI plane.
#
# THE BUG
# Convex actions run INSIDE the backend container. `myos-ai` binds 127.0.0.1:8770,
# which inside that container means the container itself, so `chat.stream` could
# never reach the inference plane and chat generation was dead. This is the
# long-deferred AI-plane P0; it is a networking defect, not an application one.
#
# WHY 0.0.0.0 AND NOT THE BRIDGE IP
# Binding 172.18.0.1 directly would repeat the PostgreSQL boot race fixed in
# 62-convex-postgres.sh: services start before Docker creates the compose bridge,
# so binding a named interface fails at boot ("Cannot assign requested address")
# and only shows up after a reboot. 0.0.0.0 covers interfaces created later.
#
# Exposure is closed by three independent layers, none of which is the bind address:
#   1. ufw INPUT policy DROP; only 22/tcp, 5432 and 8770 from 172.18.0.0/16
#   2. every /v1 route requires the x-service-key shared secret
#   3. 172.18.0.0/16 is not routable from outside this host
set -euo pipefail

REPO=${REPO:-/opt/myos}
AI_ENV=$REPO/services/ai/.env
UNIT=/etc/systemd/system/myos-ai.service
SUBNET=${SUBNET:-172.18.0.0/16}
GW=${GW:-172.18.0.1}
PORT=8770
STAMP=$(date +%Y%m%d-%H%M%S)

say() { printf '  %s\n' "$*"; }

echo "=== 65-ai-plane-reachability ==="
[ -f "$UNIT" ]   || { echo "FATAL: $UNIT missing" >&2; exit 1; }
[ -f "$AI_ENV" ] || { echo "FATAL: $AI_ENV missing" >&2; exit 1; }

echo "--- 1. current bind ---"
ss -tlnp 2>/dev/null | grep ":$PORT" | sed 's/^/  /' || say "(nothing listening on $PORT)"

echo "--- 2. bind on all interfaces instead of loopback ---"
cp -a "$UNIT" "$UNIT.bak-$STAMP"
# The unit hardcodes --host 127.0.0.1 and ignores AI_BIND_HOST from the env file.
sed -i "s#--host 127\.0\.0\.1#--host 0.0.0.0#" "$UNIT"
grep -q -- "--host 0.0.0.0" "$UNIT" || { echo "FATAL: could not rewrite --host in $UNIT" >&2; exit 1; }
say "unit ExecStart now binds 0.0.0.0 (backup: $UNIT.bak-$STAMP)"

# Keep the env file honest so the two do not disagree for the next reader.
if grep -qE '^AI_BIND_HOST=' "$AI_ENV"; then
  cp -a "$AI_ENV" "$AI_ENV.bak-$STAMP"
  sed -i "s#^AI_BIND_HOST=.*#AI_BIND_HOST=0.0.0.0#" "$AI_ENV"
  chmod 600 "$AI_ENV"
  say "services/ai/.env AI_BIND_HOST=0.0.0.0"
fi

echo "--- 3. ufw: only the compose network may reach $PORT ---"
if ufw status | grep -q "$PORT.*$SUBNET"; then
  say "ufw rule already present"
else
  ufw allow from "$SUBNET" to any port "$PORT" proto tcp comment 'convex container -> ai plane' >/dev/null
  say "ufw rule added: $SUBNET -> $PORT/tcp"
fi
ufw status | grep -E "^Status|$PORT" | sed 's/^/    /'

echo "--- 4. restart the AI plane ---"
systemctl daemon-reload
systemctl restart myos-ai
for i in $(seq 1 40); do
  curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
say "myos-ai: $(systemctl is-active myos-ai)"
ss -tlnp 2>/dev/null | grep ":$PORT" | sed 's/^/  /'

echo "--- 5. reachable from the host ---"
say "127.0.0.1:$PORT/healthz -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:$PORT/healthz)"
say "$GW:$PORT/healthz       -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://$GW:$PORT/healthz)"

echo "--- 6. reachable from INSIDE the compose network (the check that matters) ---"
CODE=$(docker run --rm --network self-hosted_default curlimages/curl:latest \
  -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$GW:$PORT/healthz" 2>/dev/null || echo ERR)
say "container -> $GW:$PORT/healthz -> $CODE"
if [ "$CODE" != "200" ]; then
  echo "FATAL: the Convex backend still cannot reach the AI plane (got $CODE)." >&2
  echo "       check ufw, the bind address, and that myos-ai is running." >&2
  exit 1
fi

echo "--- 7. /v1/generate must reject an unauthenticated call (auth still enforced) ---"
UNAUTH=$(docker run --rm --network self-hosted_default curlimages/curl:latest \
  -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "http://$GW:$PORT/v1/generate" \
  -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo ERR)
say "container -> /v1/generate with NO service key -> $UNAUTH (must be 401/403/422, never 200)"
case "$UNAUTH" in
  200) echo "FATAL: /v1/generate answered an unauthenticated request" >&2; exit 1 ;;
esac

echo
echo "65-ai-plane-reachability: DONE"
