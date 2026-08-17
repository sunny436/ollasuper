#!/usr/bin/env bash
# READ-ONLY discovery. Changes nothing, starts nothing, deploys nothing.
#
# The tunnel that serves leads.networkershome.com was set up outside this repo
# (deploy/30-cf-tunnel.sh only makes QUICK trycloudflare tunnels), so nothing here
# knows what it is. 57 and 58 both branch on the answers below — run this first and
# paste the whole output back.
#
# Three questions decide everything:
#   Q1 Is the tunnel LOCALLY-managed (config.yml on disk, we can edit ingress) or
#      REMOTELY-managed (Zero Trust dashboard, ingress lives in Cloudflare)?
#   Q2 Is networkershome.com in the SAME Cloudflare account as ollasuper.com
#      (bc7f0a3ee7f73a27bcbd9f7c82a46876)? One tunnel can serve hostnames across
#      zones only within one account.
#   Q3 What are the CURRENT origin/URL values? They are only knowable here — the
#      built NEXT_PUBLIC_CONVEX_URL could not be recovered from the public bundle.
set -uo pipefail
say() { printf '\n=== %s ===\n' "$1"; }

say "Q1a cloudflared binary"
command -v cloudflared >/dev/null 2>&1 && cloudflared --version || echo "cloudflared NOT on PATH"
ls -l /usr/local/bin/cloudflared 2>/dev/null

say "Q1b cloudflared systemd units + ExecStart"
# ExecStart is the tell:
#   'tunnel --url http://localhost:N'  -> QUICK tunnel (trycloudflare, ephemeral)
#   'tunnel run <NAME|UUID>'           -> NAMED, LOCALLY-managed (config.yml + creds json)
#   'tunnel run --token eyJ...'        -> NAMED, REMOTELY-managed (ingress in the dashboard)
systemctl list-units --type=service --all --no-legend --no-pager 2>/dev/null \
  | awk '{print $1}' | grep -iE 'cloudflare|cf-|tunnel' || echo "(no matching units)"
for u in $(systemctl list-unit-files --no-legend --no-pager 2>/dev/null | awk '{print $1}' | grep -iE 'cloudflare|cf-|tunnel'); do
  printf -- '--- %s : %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null)"
  # Redact any inline --token: it is a full tunnel credential.
  systemctl cat "$u" 2>/dev/null | grep -E '^(ExecStart|Environment)' | sed -E 's/(--token[= ])[A-Za-z0-9._-]+/\1<REDACTED>/g'
done

say "Q1c cloudflared config files"
for f in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml \
         /root/.cloudflared/config.yml /root/.cloudflared/config.yaml \
         "$HOME/.cloudflared/config.yml" "$HOME/.cloudflared/config.yaml"; do
  [ -f "$f" ] && { printf -- '--- %s\n' "$f"; cat "$f"; }
done
echo "-- credentials / cert files (names only, contents are secret):"
ls -l /etc/cloudflared/ /root/.cloudflared/ "$HOME/.cloudflared/" 2>/dev/null | grep -vE '^total' || echo "(none)"

say "Q1d VERDICT hint"
if ls /root/.cloudflared/*.json "$HOME"/.cloudflared/*.json /etc/cloudflared/*.json >/dev/null 2>&1 \
   && { [ -f /etc/cloudflared/config.yml ] || [ -f /root/.cloudflared/config.yml ]; }; then
  echo "LOOKS LOCALLY-MANAGED -> 57 can add ingress rules itself (happy path)"
elif systemctl cat '*' 2>/dev/null | grep -q -- '--token'; then
  echo "LOOKS REMOTELY-MANAGED -> ingress must be added in the Zero Trust dashboard,"
  echo "  or you must supply a token with Account -> Cloudflare Tunnel:Edit"
else
  echo "INCONCLUSIVE -> read Q1b/Q1c above by hand"
fi

say "Q2 tunnel list + owning account"
# Needs cert.pem (from 'cloudflared tunnel login'). If it fails, the tunnel is
# almost certainly remotely-managed via --token, which answers Q1 as well.
cloudflared tunnel list 2>&1 | head -20 || true
echo "-- the tunnel ID behind app.ollasuper.com today is 8ad8b94d-14dd-4504-a2af-d4daf0f1d4f0"
echo "-- if that ID appears above, ollasuper.com and this VM share one account and one tunnel"

say "Q3a /opt/myos/apps/app/.env  (the built NEXT_PUBLIC_CONVEX_URL)"
cat /opt/myos/apps/app/.env 2>/dev/null || echo "(absent)"

say "Q3b /opt/myos/self-hosted/.env  (convex origins)"
cat /opt/myos/self-hosted/.env 2>/dev/null || echo "(absent)"

say "Q3c /opt/myos/backend-echo/.env  (secrets redacted)"
sed -E 's/^(.*(KEY|SECRET|TOKEN|PASS)[A-Z_]*=).*/\1<REDACTED>/I' /opt/myos/backend-echo/.env 2>/dev/null || echo "(absent)"

say "Q3d convex SITE_URL / CONVEX_SITE_URL"
( cd /opt/myos/packages/backend 2>/dev/null \
  && for v in SITE_URL CONVEX_SITE_URL; do
       printf '%s=' "$v"
       /usr/bin/node /opt/myos/node_modules/convex/bin/main.js env get "$v" 2>&1 | tail -1
     done ) || echo "(convex CLI unavailable — needs .env.local admin key)"

say "Q3e what is actually listening"
(ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ':(3000|3210|3211|4000|6791|8770)\b' || echo "(none of the expected ports)"

say "Q3f local health"
for p in 3000 3210 3211; do
  printf ':%s -> ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 "http://127.0.0.1:$p/" || echo "no answer"
done

say "Q4 does the Convex CONTAINER resolve + reach the public internet?"
# 57's pre-flight depends on this: after cutover the container must fetch its own
# issuer at https://convex-site.ollasuper.com/... which hairpins out to Cloudflare
# and back in. Prove general egress now, before anything is changed.
CID=$(cd /opt/myos/self-hosted 2>/dev/null && docker compose ps -q backend 2>/dev/null | head -1)
if [ -n "${CID:-}" ]; then
  echo "container: $CID"
  docker exec "$CID" sh -c 'curl -s -o /dev/null -w "egress to cloudflare.com: %{http_code}\n" --max-time 8 https://www.cloudflare.com/ 2>&1' || echo "(curl absent in container — 57 will use a different probe)"
  docker exec "$CID" sh -c 'curl -s -o /dev/null -w "reaches app.ollasuper.com today: %{http_code}\n" --max-time 8 https://app.ollasuper.com/ 2>&1' || true
else
  echo "(convex backend container not found via docker compose ps)"
fi

say "DONE"
echo "Paste this entire output back. Nothing was modified."
