#!/usr/bin/env bash
# Local email catcher: Mailpit (SMTP :1025, web UI :8025).
#
# AUDIT D-03. This used to publish BOTH ports on every interface AND open an
# unauthenticated cloudflared quick tunnel to the UI — i.e. every auth code
# Mailpit ever caught was readable by anyone holding a trycloudflare URL.
#   * UI  -> 127.0.0.1 only (use an SSH tunnel: ssh -L 8025:127.0.0.1:8025 ...)
#   * SMTP -> the pinned compose bridge gateway (172.18.0.1, see
#             self-hosted/docker-compose.override.yml), which is where the
#             Convex container reaches it — not the LAN.
#   * the cf-mail quick tunnel is REMOVED (stopped, disabled, unit deleted).
set -uo pipefail
SMTP_BIND=${MAILPIT_SMTP_BIND:-172.18.0.1}

docker rm -f mailpit 2>/dev/null || true
docker run -d --name mailpit --restart unless-stopped \
  -p "${SMTP_BIND}:1025:1025" -p 127.0.0.1:8025:8025 axllent/mailpit 2>&1 | tail -1

if systemctl list-unit-files cf-mail.service >/dev/null 2>&1; then
  systemctl disable --now cf-mail >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/cf-mail.service
  systemctl daemon-reload
  echo "cf-mail quick tunnel removed"
fi

curl -s -o /dev/null -w "mailpit api (loopback): %{http_code}\n" http://127.0.0.1:8025/api/v1/messages
echo MAILPIT_DONE
