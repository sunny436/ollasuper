#!/usr/bin/env bash
# 67-cloudflared-token-rotate.sh — install a REFRESHED tunnel token safely.
#
# Run after refreshing the token in the Cloudflare Zero Trust dashboard:
#   Networks -> Tunnels -> <tunnel> -> ... -> Refresh token
#
# USAGE — the token is read from STDIN, never from argv:
#   ssh root@vm 'bash /opt/myos/deploy/67-cloudflared-token-rotate.sh' <<< '<NEW_TOKEN>'
# Passing it as an argument would expose it in `ps` to every local user, which is
# the exact class of problem 66-cloudflared-token-secure.sh was written to fix.
#
# Rolls back automatically if the tunnel does not serve traffic afterwards, so a
# bad paste cannot take the site down.
set -euo pipefail

ENVFILE=/etc/cloudflared/tunnel.env
PROBE_URL=${PROBE_URL:-https://app.ollasuper.com/login}
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=/root/tunnel.env.bak-$STAMP

say() { printf '  %s\n' "$*"; }

echo "=== 67-cloudflared-token-rotate ==="

# ---------------------------------------------------------------------------
echo "--- 1. read the new token from stdin ---"
NEW=$(cat); NEW=$(printf '%s' "$NEW" | tr -d ' \t\r\n')
[ -n "$NEW" ] || { echo "FATAL: no token on stdin" >&2; exit 1; }
# Connector tokens are base64 JSON carrying {a: account, t: tunnel, s: secret}.
case "$NEW" in
  eyJ*) : ;;
  *) echo "FATAL: that does not look like a tunnel token (expected it to start 'eyJ')" >&2; exit 1 ;;
esac
say "new token accepted (${#NEW} chars, not echoed)"

if [ -s "$ENVFILE" ] && grep -q "^TUNNEL_TOKEN=$NEW$" "$ENVFILE"; then
  say "this is already the installed token — nothing to do"; exit 0
fi

# Sanity: the refreshed token must belong to the SAME tunnel, or we would point
# the connector at something else entirely.
old_field() { # field, file-or-token
  printf '%s' "$1" | sed 's/^eyJ/eyJ/' | base64 -d 2>/dev/null \
    | grep -oE "\"$2\":\"[^\"]+\"" | head -1 | sed -E "s/.*:\"([^\"]+)\"/\1/"
}
if [ -s "$ENVFILE" ]; then
  OLD=$(grep -oP '(?<=^TUNNEL_TOKEN=).*' "$ENVFILE" || true)
  if [ -n "$OLD" ]; then
    OT=$(old_field "$OLD" t); NT=$(old_field "$NEW" t)
    if [ -n "$OT" ] && [ -n "$NT" ] && [ "$OT" != "$NT" ]; then
      echo "FATAL: the new token is for tunnel $NT but the current one is $OT." >&2
      echo "       Refusing — that would repoint the connector at a different tunnel." >&2
      exit 1
    fi
    [ -n "$NT" ] && say "tunnel id matches: $NT"
  fi
fi

# ---------------------------------------------------------------------------
echo "--- 2. install it (0600, root-only) ---"
[ -s "$ENVFILE" ] && { cp -a "$ENVFILE" "$BACKUP"; chmod 600 "$BACKUP"; say "backup: $BACKUP"; }
install -d -m 0700 -o root -g root "$(dirname "$ENVFILE")"
umask 077
printf 'TUNNEL_TOKEN=%s\n' "$NEW" > "$ENVFILE"
chmod 0600 "$ENVFILE"; chown root:root "$ENVFILE"
say "$ENVFILE -> $(stat -c '%a %U:%G' "$ENVFILE")"

# ---------------------------------------------------------------------------
echo "--- 3. restart and verify the tunnel actually serves traffic ---"
systemctl restart cloudflared
ok=0
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PROBE_URL" 2>/dev/null || echo 000)
  [ "$code" = "200" ] && { ok=1; break; }
  sleep 3
done

if [ "$ok" != 1 ]; then
  echo "FATAL: $PROBE_URL did not return 200 — ROLLING BACK to the previous token" >&2
  if [ -f "$BACKUP" ]; then
    cp -a "$BACKUP" "$ENVFILE"; chmod 600 "$ENVFILE"
    systemctl restart cloudflared; sleep 12
    echo "  rolled back; probe now: $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PROBE_URL")" >&2
  else
    echo "  no backup existed to restore" >&2
  fi
  exit 1
fi

say "cloudflared: $(systemctl is-active cloudflared)"
say "$PROBE_URL -> 200"
journalctl -u cloudflared --since "-2 min" --no-pager 2>/dev/null \
  | grep -icE "registered tunnel connection|connection established" \
  | sed 's/^/  connector registrations since restart: /'

echo "--- 4. the Convex path must still work through the tunnel ---"
say "https://app.ollasuper.com/__cvx/version -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://app.ollasuper.com/__cvx/version)"

echo "--- 5. exposure check ---"
say "unit mode: $(stat -c %a /etc/systemd/system/cloudflared.service)  envfile mode: $(stat -c %a "$ENVFILE")"
say "literal tokens in systemctl cat: $(systemctl cat cloudflared 2>/dev/null | grep -cE -- '--token[= ]+[A-Za-z0-9+/=_-]{20,}')"

echo
echo "67-cloudflared-token-rotate: DONE — the old token is now invalid at Cloudflare."
echo "  Remove the stale backup once you are happy: shred -u $BACKUP"
