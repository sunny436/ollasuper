#!/usr/bin/env bash
# 76-mcp-local.sh — install the local MCP bridge unit and start one server.
#
#   bash deploy/76-mcp-local.sh install            # unit template + dirs
#   bash deploy/76-mcp-local.sh start <slug> <port> # start/enable one server
#   bash deploy/76-mcp-local.sh stop <slug>
#   bash deploy/76-mcp-local.sh status <slug>       # unit + attestation
#
# WHAT REPLACED THE DOCKER MCP GATEWAY (audit H-12). The previous script ran
# `docker mcp gateway run`, which is not installed on this host and whose
# flags cannot be inspected. The bridge (services/ai/bridge/mcp_bridge.py)
# runs the container itself with every hardening flag explicit, attests it
# with `docker inspect`, and serves it on loopback behind a bearer token. The
# AI plane refuses to dial a local server without a verified attestation.
#
# NOTHING HERE CHANGES THE PLANE'S FLAG. `MCP_LOCAL_ENABLED` stays whatever
# services/ai/.env says (off on production); this script only makes a server
# launchable and attested for when the operator turns it on.
set -euo pipefail
REPO=${REPO:-/opt/myos}
AI="$REPO/services/ai"
ACTION=${1:-}

case "$ACTION" in
  install)
    install -d -m 0750 /etc/myos/mcp-local
    install -d -m 0755 /run/myos/mcp-local
    install -m 0644 "$REPO/deploy/units/myos-mcp-local@.service" /etc/systemd/system/
    systemctl daemon-reload
    grep -q '^MCP_GATEWAY_AUTH_TOKEN=' "$AI/.env" || {
      echo "MCP_GATEWAY_AUTH_TOKEN is not set in $AI/.env; generating one" >&2
      printf 'MCP_GATEWAY_AUTH_TOKEN=%s\n' "$(openssl rand -hex 32)" >> "$AI/.env"
    }
    echo "installed: myos-mcp-local@.service"
    ;;
  start)
    SLUG=${2:?slug}; PORT=${3:?port}
    install -d -m 0755 "/etc/systemd/system/myos-mcp-local@${SLUG}.service.d"
    printf '[Service]\nEnvironment=MCP_LOCAL_PORT=%s\n' "$PORT" \
      > "/etc/systemd/system/myos-mcp-local@${SLUG}.service.d/port.conf"
    systemctl daemon-reload
    systemctl enable --now "myos-mcp-local@${SLUG}" || true
    sleep 6
    systemctl is-active "myos-mcp-local@${SLUG}" || {
      journalctl -u "myos-mcp-local@${SLUG}" -n 20 --no-pager
      exit 1
    }
    cat "/run/myos/mcp-local/${SLUG}.json"; echo
    ;;
  stop)
    SLUG=${2:?slug}
    systemctl disable --now "myos-mcp-local@${SLUG}" || true
    rm -rf "/etc/systemd/system/myos-mcp-local@${SLUG}.service.d"
    systemctl daemon-reload
    echo "stopped: $SLUG"
    ;;
  status)
    SLUG=${2:?slug}
    systemctl is-active "myos-mcp-local@${SLUG}" || true
    cat "/run/myos/mcp-local/${SLUG}.json" 2>/dev/null || echo "no attestation"
    docker inspect "myos-mcp-${SLUG}" --format \
      'digest={{.Image}} user={{.Config.User}} caps={{.HostConfig.CapDrop}} ro={{.HostConfig.ReadonlyRootfs}} net={{.HostConfig.NetworkMode}} mem={{.HostConfig.Memory}} pids={{.HostConfig.PidsLimit}}' \
      2>/dev/null || echo "no container"
    ;;
  *)
    echo "usage: $0 install | start <slug> <port> | stop <slug> | status <slug>" >&2
    exit 2
    ;;
esac
