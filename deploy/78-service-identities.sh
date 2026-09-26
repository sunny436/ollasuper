#!/usr/bin/env bash
# Dedicated service identity + least privilege for the AI plane (audit D-02).
#
# myos-ai and myos-scheduler ran as ROOT with the whole code tree (.venv and
# .env included) writable. Moving them to an unprivileged user is right, but it
# can break things only a real host reveals — above all the attachment sandbox
# (app/sandbox/harness.py), which runs `unshare -rnm`. Ubuntu 23.10+ AppArmor
# (kernel.apparmor_restrict_unprivileged_userns=1) forbids user namespaces to
# every non-root process, so as a plain user the sandbox fails CLOSED and every
# image/PDF/spreadsheet attachment is refused. That is measured, not assumed:
# `runuser -u nobody -- unshare -r true` fails with "write failed
# /proc/self/uid_map: Operation not permitted" on the production VM.
#
# THE SCOPED FIX — the global setting is left exactly as it is. Ubuntu ships the
# same pattern for LXC (/etc/apparmor.d/lxc-unshare): a profile that grants
# `userns` to ONE binary. Here that binary is a PRIVATE copy of util-linux
# `unshare` at /opt/myos-sandbox/bin/unshare, root:myos-ai 0750 — so the service
# user can create namespaces for its sandbox, and no other local user can even
# execute it. The services get that directory first on PATH, which is how the
# harness (shutil.which("unshare")) finds it.
#
#   (no flag)   preflight only — prints what it checks, changes nothing
#   --apply     install the prerequisites (idempotent, additive), prove a REAL
#               sandboxed decode as myos-ai, then install the drop-ins and restart
#               one unit at a time, health-checking each; failure rolls back
#   --rollback  remove the drop-ins, restore .env to root:root 0600, restart as
#               before (the user, private binary and profile stay; they grant
#               nothing to anyone else)
#
# What the drop-ins do (base units untouched; delete the drop-in to revert):
#   * User/Group=myos-ai — no root, no root-owned files, no docker socket.
#   * The code tree becomes READ-ONLY; only /var/lib/myos-ai (state) and
#     /var/cache/myos-ai are writable, plus /opt/secaudit/fixture, which the
#     existing secaudit.conf drop-in re-adds (it sorts after this one).
#   * .env becomes root:myos-ai 0640: the settings loader reads it as a file
#     (pydantic env_file), and the process already holds every value in its
#     environment, so this grants nothing new. No other user can read it.
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
SANDBOX_BIN=/opt/myos-sandbox/bin
AA_PROFILE=/etc/apparmor.d/myos-sandbox-unshare
SECAUDIT_FIXTURE=/opt/secaudit/fixture
SVC_PATH="$SANDBOX_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

dropin_dir() { echo "/etc/systemd/system/$1.service.d"; }
dropin() { echo "$(dropin_dir "$1")/20-service-identity.conf"; }

install_prereqs() {
  echo "=== prerequisites (additive) ==="
  if ! getent passwd "$SVC_USER" >/dev/null; then
    useradd --system --home-dir "/var/lib/$SVC_USER" --no-create-home \
      --shell /usr/sbin/nologin "$SVC_USER"
    echo "  created system user $SVC_USER"
  fi
  install -d -o root -g root -m 0755 /opt/myos-sandbox "$SANDBOX_BIN"
  install -o root -g "$SVC_USER" -m 0750 /usr/bin/unshare "$SANDBOX_BIN/unshare"
  cat > "$AA_PROFILE" <<'EOF'
# OllaSuper attachment sandbox (audit D-02; deploy/78-service-identities.sh).
# The ONE binary allowed to create user namespaces for the unprivileged
# myos-ai service user: a private copy of util-linux unshare, root:myos-ai
# 0750, so no other local user can run it. The global
# kernel.apparmor_restrict_unprivileged_userns=1 is left as it is. Same
# pattern Ubuntu ships for /usr/bin/lxc-unshare.
abi <abi/4.0>,
include <tunables/global>

profile myos-sandbox-unshare /opt/myos-sandbox/bin/unshare flags=(unconfined) {
  userns,

  include if exists <local/myos-sandbox-unshare>
}
EOF
  apparmor_parser -r "$AA_PROFILE"
  echo "  private unshare + AppArmor profile loaded"
  chgrp "$SVC_USER" "$AI_DIR/.env"
  chmod 0640 "$AI_DIR/.env"
  echo "  $AI_DIR/.env -> root:$SVC_USER 0640"
  if [ -d "$SECAUDIT_FIXTURE" ]; then
    chown -R "$SVC_USER:$SVC_USER" "$SECAUDIT_FIXTURE"
    echo "  $SECAUDIT_FIXTURE -> $SVC_USER (approved security fixes land here)"
  fi
}

write_dropin() {
  local unit=$1
  mkdir -p "$(dropin_dir "$unit")"
  cat > "$(dropin "$unit")" <<EOF
# Installed by deploy/78-service-identities.sh (audit D-02). Delete to revert.
[Service]
User=${SVC_USER}
Group=${SVC_USER}
# The private, AppArmor-scoped unshare first: the sandbox harness finds it by PATH.
Environment=PATH=${SVC_PATH}
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
  cd "$AI_DIR"  # the interpreter check below imports app.* from here
  local who=$SVC_USER
  getent passwd "$who" >/dev/null || { echo "  (no $SVC_USER yet — checks run as nobody)"; who=nobody; }
  local ok=1
  runuser -u "$who" -- test -r "$AI_DIR/app/main.py" \
    && echo "  ok: $who can read the code" || { echo "  FAIL: $who cannot read $AI_DIR"; ok=0; }
  runuser -u "$who" -- "$AI_DIR/.venv/bin/python" -c 'import sys' \
    && echo "  ok: $who can run the venv interpreter" \
    || { echo "  FAIL: $who cannot run $AI_DIR/.venv/bin/python (is the uv interpreter outside /root?)"; ok=0; }
  if runuser -u "$who" -- env PATH="$SVC_PATH" unshare -rnm true 2>/dev/null; then
    echo "  ok: $who creates the sandbox's user/net/mount namespaces"
  else
    echo "  FAIL: '$who' cannot 'unshare -rnm' — the attachment sandbox would fail"
    echo "        closed. Run with --apply to install the scoped unshare + profile."
    ok=0
  fi
  # The real thing, not a proxy: a sandboxed decode through the production
  # harness, as the service user, with the service's PATH and HOME.
  if [ "$ok" = 1 ]; then
    if runuser -u "$who" -- env PATH="$SVC_PATH" HOME=/tmp PYTHONDONTWRITEBYTECODE=1 \
        "$AI_DIR/.venv/bin/python" -c '
import asyncio, io, sys
sys.path.insert(0, ".")
from openpyxl import Workbook
from app.sandbox import harness
status = harness.sandbox_status()
assert status["tier"] == 1, status
wb = Workbook(); wb.active["A1"] = "ok"; buf = io.BytesIO(); wb.save(buf)
meta, _ = asyncio.run(harness.run_sandboxed(
    "xlsx_scan", buf.getvalue(), {"max_cells": 1000, "max_rows": 1000},
    timeout_s=20, fallback=None))
assert meta.get("ok"), meta
print("  ok: tier-1 sandboxed decode succeeds as the service user")
' 2>&1; then :; else echo "  FAIL: a real sandboxed decode failed as $who"; ok=0; fi
  fi
  [ "$ok" = 1 ] || { echo "PREFLIGHT FAILED — nothing switched."; exit 1; }
  echo "preflight passed"
}

apply_unit() {
  local unit=$1
  write_dropin "$unit"
  systemctl daemon-reload
  systemctl restart "$unit"
  sleep 6
  if ! systemctl is-active --quiet "$unit"; then
    echo "  FAIL: $unit did not stay up — rolling it back"
    rm -f "$(dropin "$unit")"
    systemctl daemon-reload
    systemctl restart "$unit"
    exit 1
  fi
  echo "  $unit now runs as $(systemctl show -p User --value "$unit")"
}

rollback() {
  for u in "${UNITS[@]}"; do rm -f "$(dropin "$u")"; done
  systemctl daemon-reload
  chgrp root "$AI_DIR/.env" && chmod 0600 "$AI_DIR/.env"
  for u in "${UNITS[@]}"; do systemctl restart "$u"; done
  echo SERVICE_IDENTITIES_ROLLED_BACK
}

case "$MODE" in
  preflight)
    preflight
    echo "Re-run with --apply to install the prerequisites and the drop-ins."
    ;;
  --apply)
    install_prereqs
    preflight
    for u in "${UNITS[@]}"; do apply_unit "$u"; done
    for i in $(seq 1 60); do curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1 && break; sleep 1; done
    if curl -fsS "$HEALTH_URL" >/dev/null; then
      echo "  health ok: $HEALTH_URL"
    else
      echo "  FAIL: $HEALTH_URL — rolling back"
      rollback
      exit 1
    fi
    echo SERVICE_IDENTITIES_APPLIED
    ;;
  --rollback)
    rollback
    ;;
  *)
    echo "usage: $0 [--apply|--rollback]" >&2
    exit 2
    ;;
esac
