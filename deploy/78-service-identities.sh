#!/usr/bin/env bash
# Dedicated service identity + least privilege for the AI plane (audit D-02).
#
# WHY THIS IS OPT-IN, NOT FOLDED INTO 54-ai-service.sh. myos-ai and
# myos-scheduler run as ROOT with the whole code tree (.venv and .env
# included) writable. Moving them to an unprivileged user is right, but it
# can break things that only a real host reveals — above all the attachment
# sandbox (app/sandbox/harness.py), which runs `unshare -rnm`: on Ubuntu
# 23.10+ AppArmor restricts UNPRIVILEGED user namespaces, the sandbox would
# fail CLOSED, and every image/PDF attachment would be refused. So this
# script PROVES the new identity works before it changes anything.
#
#   (no flag)   preflight only — prints what would change, changes nothing
#   --apply     preflight, then install the drop-ins and restart one unit at a
#               time, health-checking each; any failure rolls back that unit
#   --rollback  remove the drop-ins and restart as before
#
# What the drop-ins do (base units untouched; delete the drop-in to revert):
#   * User/Group=myos-ai — no root, no root-owned files, no docker socket.
#   * The code tree becomes READ-ONLY; only /var/lib/myos-ai (state) and
#     /var/cache/myos-ai are writable. .env stays root:root 0600 — systemd
#     reads EnvironmentFile as PID 1 BEFORE dropping privileges, so the service
#     process never needs (or gets) read access to the file itself.
#   * CapabilityBoundingSet= (none), no SUID/SGID, kernel tunables/modules and
#     cgroups protected. Namespaces are NOT restricted: the sandbox needs them.
#
# NOT COVERED HERE: myos-app/myos-web (deploy/06-systemd.sh) execute bun from
# /root/.bun, which an unprivileged user cannot reach. Moving bun out of /root
# (e.g. /usr/local/bin) is the prerequisite for giving those a User= too.
# edge/myos-edge.service is hardened directly (DynamicUser) — it needs nothing.
set -euo pipefail

MODE=${1:-preflight}
SVC_USER=myos-ai
AI_DIR=/opt/myos/services/ai
UNITS=(myos-ai myos-scheduler)
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:8770/healthz}

dropin_dir() { echo "/etc/systemd/system/$1.service.d"; }
dropin() { echo "$(dropin_dir "$1")/20-service-identity.conf"; }

write_dropin() {
  local unit=$1
  mkdir -p "$(dropin_dir "$unit")"
  cat > "$(dropin "$unit")" <<EOF
# Installed by deploy/78-service-identities.sh (audit D-02). Delete to revert.
[Service]
User=${SVC_USER}
Group=${SVC_USER}
# Reset the base unit's list: the code tree is read-only from here on.
ReadWritePaths=
ReadOnlyPaths=${AI_DIR}
StateDirectory=${SVC_USER}
CacheDirectory=${SVC_USER}
Environment=HOME=/var/lib/${SVC_USER}
Environment=XDG_CACHE_HOME=/var/cache/${SVC_USER}
CapabilityBoundingSet=
AmbientCapabilities=
RestrictSUIDSGID=true
LockPersonality=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictRealtime=true
# The Docker socket is root-equivalent; nothing in this unit may reach it.
InaccessiblePaths=-/var/run/docker.sock -/run/docker.sock
EOF
}

preflight() {
  echo "=== preflight ==="
  if ! getent passwd "$SVC_USER" >/dev/null; then
    echo "  system user $SVC_USER does not exist yet"
    if [ "$MODE" = "--apply" ]; then
      useradd --system --home-dir "/var/lib/$SVC_USER" \
        --shell /usr/sbin/nologin "$SVC_USER"
      echo "  created $SVC_USER"
    fi
  fi
  if ! getent passwd "$SVC_USER" >/dev/null; then
    echo "  (user absent in preflight mode — checks below run as nobody)"
  fi
  local who=$SVC_USER
  getent passwd "$who" >/dev/null || who=nobody
  local ok=1
  runuser -u "$who" -- test -r "$AI_DIR/app/main.py" \
    && echo "  ok: $who can read the code" || { echo "  FAIL: $who cannot read $AI_DIR"; ok=0; }
  runuser -u "$who" -- "$AI_DIR/.venv/bin/python" -c 'import sys' \
    && echo "  ok: $who can run the venv interpreter" \
    || { echo "  FAIL: $who cannot run $AI_DIR/.venv/bin/python (is the uv interpreter outside /root?)"; ok=0; }
  if runuser -u "$who" -- unshare -rnm true 2>/dev/null; then
    echo "  ok: unprivileged user namespaces work (attachment sandbox tier 1)"
  else
    echo "  FAIL: '$who' cannot 'unshare -rnm' — the attachment sandbox would fail"
    echo "        closed and refuse every image/PDF. On Ubuntu 23.10+ this is the"
    echo "        AppArmor userns restriction; allow it for unshare first."
    ok=0
  fi
  [ "$ok" = 1 ] || { echo "PREFLIGHT FAILED — nothing changed."; exit 1; }
  echo "preflight passed"
}

apply_unit() {
  local unit=$1
  write_dropin "$unit"
  systemctl daemon-reload
  systemctl restart "$unit"
  sleep 4
  if ! systemctl is-active --quiet "$unit"; then
    echo "  FAIL: $unit did not stay up — rolling it back"
    rm -f "$(dropin "$unit")"
    systemctl daemon-reload
    systemctl restart "$unit"
    exit 1
  fi
  echo "  $unit now runs as $(systemctl show -p User --value "$unit")"
}

case "$MODE" in
  preflight)
    preflight
    echo "Re-run with --apply to install the drop-ins."
    ;;
  --apply)
    preflight
    for u in "${UNITS[@]}"; do apply_unit "$u"; done
    curl -fsS "$HEALTH_URL" >/dev/null && echo "  health ok: $HEALTH_URL" \
      || { echo "  FAIL: $HEALTH_URL — run --rollback"; exit 1; }
    echo SERVICE_IDENTITIES_APPLIED
    ;;
  --rollback)
    for u in "${UNITS[@]}"; do rm -f "$(dropin "$u")"; done
    systemctl daemon-reload
    for u in "${UNITS[@]}"; do systemctl restart "$u"; done
    echo SERVICE_IDENTITIES_ROLLED_BACK
    ;;
  *)
    echo "usage: $0 [--apply|--rollback]" >&2
    exit 2
    ;;
esac
