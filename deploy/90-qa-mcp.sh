#!/usr/bin/env bash
# 90-qa-mcp.sh — stand up (or tear down) the Phase 9 red-team MCP server.
#
#   bash deploy/90-qa-mcp.sh up
#   bash deploy/90-qa-mcp.sh down
#
# WHAT THIS IS. A deliberately hostile MCP server used to prove that OllaSuper's
# policy, approval gate and rendering survive a server that lies, stalls, floods
# and tries to give the model orders. It exists because no third party's server
# can be asked to do those things on command, and a red-team phase run only
# against well-behaved servers cannot reach its own matrix.
#
# WHY 90 AND NOT 78. The 50-77 range is the product's deploy sequence, run in
# order on a fresh box. This is not part of that sequence and must never be run
# by it — the 90s are QA-only and are expected to be torn down again.
#
# WHAT IT DOES NOT DO. It reads no file, runs no shell, opens no socket and
# holds no credential. Every hostile behaviour is a string or a sleep.
#
# IT IS PUBLICLY REACHABLE WHILE UP, at /__qa-mcp on the app hostname. That is
# deliberate: `assert_dialable` requires public https, and the alternative was
# to weaken the guard, which a QA phase must never do. Nothing it serves is
# sensitive, and `down` removes it.
set -euo pipefail

REPO=${REPO:-/opt/myos}
AI="$REPO/services/ai"
UNIT=/etc/systemd/system/qa-mcp.service
PORT=${QA_MCP_PORT:-8799}
ACTION=${1:-}

case "$ACTION" in
  up)
    echo "[1/3] writing the unit"
    cat > "$UNIT" <<UNITEOF
[Unit]
Description=Phase 9 QA red-team MCP server (TEARDOWN AFTER THE RUN)
After=network.target

[Service]
Type=simple
WorkingDirectory=$AI
Environment=QA_MCP_PORT=$PORT
Environment=QA_MCP_PUBLIC_HOST=app.ollasuper.com
# --workers 1 for the same reason the AI plane uses it: the MCP session state
# this server keeps (the flaky_tool call counter) is in-process, and a second
# worker would make the retry-duplication assertion meaningless.
ExecStart=$AI/.venv/bin/python -m uvicorn qa.mcp_server:app --host 127.0.0.1 --port $PORT --workers 1
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNITEOF

    echo "[2/3] starting"
    systemctl daemon-reload
    systemctl enable --now qa-mcp >/dev/null 2>&1 || systemctl restart qa-mcp
    sleep 3
    systemctl is-active qa-mcp

    echo "[3/3] restarting the edge proxy so /__qa-mcp routes"
    systemctl restart myos-edge
    sleep 2
    systemctl is-active myos-edge
    echo "qa-mcp: up on 127.0.0.1:$PORT, published at /__qa-mcp"
    ;;

  down)
    echo "[1/2] stopping and removing the unit"
    systemctl disable --now qa-mcp >/dev/null 2>&1 || true
    rm -f "$UNIT"
    systemctl daemon-reload
    echo "[2/2] restarting the edge proxy (route removed in source)"
    systemctl restart myos-edge
    sleep 2
    systemctl is-active myos-edge
    echo "qa-mcp: down"
    ;;

  *)
    echo "usage: $0 up|down" >&2
    exit 2
    ;;
esac
