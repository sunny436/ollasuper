#!/usr/bin/env bash
# 66-cloudflared-token-secure.sh — get the tunnel token out of a world-readable file.
#
# THE PROBLEM
# The connector token was passed inline on the ExecStart line of
# /etc/systemd/system/cloudflared.service, which is mode 0644. Any local user
# could read a credential that authorises a connector for the tunnel serving
# app.ollasuper.com — `systemctl cat cloudflared` prints it, and so does `cat`.
#
# WHAT THIS DOES
# Moves the token into /etc/cloudflared/tunnel.env (0600, root-owned) and has
# systemd inject it via EnvironmentFile. The unit itself is also tightened to
# 0600 so the reference cannot leak anything by inspection.
#
# WHAT THIS DOES **NOT** DO: rotate the token.
# Rotation is an account-scoped Zero Trust operation. The API token available here
# (cf_tunnel_info.txt) is ZONE-scoped for ollasuper.com: a zone read succeeds, but
# GET /accounts/<acct>/cfd_tunnel/<id> returns "1001: Not authorized". Rotation
# therefore needs either the Zero Trust dashboard (Networks -> Tunnels -> Refresh
# token) or an API token carrying "Cloudflare Tunnel: Edit". Until the token is
# rotated it should still be treated as exposed -- securing the file reduces future
# exposure, it does not undo past exposure.
#
# Safe to re-run. Rolls the unit back automatically if the tunnel fails to reconnect.
set -euo pipefail

UNIT=/etc/systemd/system/cloudflared.service
ENVDIR=/etc/cloudflared
ENVFILE=$ENVDIR/tunnel.env
STAMP=$(date +%Y%m%d-%H%M%S)
PROBE_URL=${PROBE_URL:-https://app.ollasuper.com/login}

say() { printf '  %s\n' "$*"; }

echo "=== 66-cloudflared-token-secure ==="
[ -f "$UNIT" ] || { echo "FATAL: $UNIT missing" >&2; exit 1; }

echo "--- 1. current exposure ---"
say "unit mode: $(stat -c '%a %U:%G' "$UNIT")"
if grep -qE -- '--token[= ]+[A-Za-z0-9+/=_-]{20,}' "$UNIT"; then
  say "token is INLINE in ExecStart (readable by any local user)"
else
  say "no inline token found — already secured?"
fi

echo "--- 2. extract the token (never echoed) ---"
TOKEN=$(grep -oE -- '--token[= ]+[A-Za-z0-9+/=_-]+' "$UNIT" | head -1 | sed -E 's/^--token[= ]+//')
if [ -z "$TOKEN" ]; then
  if [ -s "$ENVFILE" ] && grep -q '^TUNNEL_TOKEN=' "$ENVFILE"; then
    say "already externalised to $ENVFILE — nothing to move"
    TOKEN=$(grep -oP '(?<=^TUNNEL_TOKEN=).*' "$ENVFILE")
  else
    echo "FATAL: no token inline and none in $ENVFILE" >&2; exit 1
  fi
fi
say "token recovered (${#TOKEN} chars)"

echo "--- 3. write it to a root-only environment file ---"
install -d -m 0700 -o root -g root "$ENVDIR"
umask 077
printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" > "$ENVFILE"
chmod 0600 "$ENVFILE"; chown root:root "$ENVFILE"
say "$ENVFILE -> $(stat -c '%a %U:%G' "$ENVFILE")"

echo "--- 4. rewrite the unit to reference it ---"
cp -a "$UNIT" "/root/cloudflared.service.bak-$STAMP"
chmod 600 "/root/cloudflared.service.bak-$STAMP"
say "backup (contains the old inline token, 0600): /root/cloudflared.service.bak-$STAMP"

# Replace the inline token with the variable reference.
sed -i -E 's#(--token)[= ]+[A-Za-z0-9+/=_-]+#\1 ${TUNNEL_TOKEN}#' "$UNIT"
# Add EnvironmentFile under [Service] if it is not already there.
grep -q "EnvironmentFile=$ENVFILE" "$UNIT" || sed -i "0,/^\[Service\]/s##[Service]\nEnvironmentFile=$ENVFILE#" "$UNIT"
chmod 0600 "$UNIT"
say "unit mode now: $(stat -c '%a %U:%G' "$UNIT")"

echo "--- 5. the token must no longer be visible in the unit ---"
if grep -qE -- '--token[= ]+[A-Za-z0-9+/=_-]{20,}' "$UNIT"; then
  echo "FATAL: token still inline after rewrite; restoring" >&2
  cp -a "/root/cloudflared.service.bak-$STAMP" "$UNIT"; systemctl daemon-reload; exit 1
fi
say "ExecStart now: $(grep -E '^ExecStart' "$UNIT" | sed -E 's#(--token) .*#\1 <from EnvironmentFile>#')"

echo "--- 6. restart and confirm the tunnel actually reconnects ---"
systemctl daemon-reload
systemctl restart cloudflared
ok=0
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PROBE_URL" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 3
done
if [ "$ok" != 1 ]; then
  echo "FATAL: $PROBE_URL did not return 200 after the restart — ROLLING BACK" >&2
  cp -a "/root/cloudflared.service.bak-$STAMP" "$UNIT"
  chmod 0644 "$UNIT"
  systemctl daemon-reload; systemctl restart cloudflared
  sleep 10
  echo "  rolled back; probe now: $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PROBE_URL")" >&2
  exit 1
fi
say "cloudflared: $(systemctl is-active cloudflared)"
say "$PROBE_URL -> 200"
journalctl -u cloudflared --since "-2 min" --no-pager 2>/dev/null \
  | grep -icE "registered tunnel connection|connection established" | sed 's/^/  connector registrations since restart: /'

echo "--- 7. verify no world-readable copy of the token remains ---"
LEAKS=0
for f in "$UNIT" $(ls /etc/systemd/system/cloudflared.service.d/*.conf 2>/dev/null); do
  if grep -qE -- '--token[= ]+[A-Za-z0-9+/=_-]{20,}' "$f" 2>/dev/null; then
    echo "  LEAK: $f"; LEAKS=$((LEAKS+1))
  fi
done
say "world-readable files still containing the token: $LEAKS"
say "systemctl cat now shows: $(systemctl cat cloudflared 2>/dev/null | grep -c 'TUNNEL_TOKEN}') variable reference(s), 0 literals"

echo
echo "66-cloudflared-token-secure: DONE"
echo "  STILL REQUIRED: rotate the token. It was world-readable, so treat it as"
echo "  compromised until refreshed in Zero Trust -> Networks -> Tunnels."
