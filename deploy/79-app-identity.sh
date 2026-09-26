#!/usr/bin/env bash
# Dedicated service identity + hardening for the Next.js app unit (audit D-02,
# the "generated Next.js units omit User=" half; 78-service-identities.sh covers
# the AI plane, edge/myos-edge.service is DynamicUser already).
#
# myos-app ran as ROOT with no sandboxing at all, because its ExecStart was
# /root/.bun/bin/bun and /root is 0700 — no other identity can reach it. This
# copies the SAME bun binary to /usr/local/bin (root-owned, read/exec for all),
# runs the unit as a new `myos-app` system user, and makes everything read-only
# except Next's runtime cache directories.
#
# Builds keep running as root exactly as before (deploy/68 rebuilds with
# /root/.bun/bin/bun). A rebuild recreates .next root-owned, so the runtime
# cache dirs are re-created and handed to myos-app by an ExecStartPre that runs
# as root (`+`) on every start — a rebuild can never leave the app unable to
# write its cache.
#
#   (no flag)   preflight only — changes nothing
#   --apply     install bun + user, preflight, install the drop-in, restart,
#               wait for /login; any failure rolls back
#   --rollback  remove the drop-in and restart as before
set -euo pipefail

MODE=${1:-preflight}
SVC_USER=myos-app
APP_DIR=/opt/myos/apps/app
UNIT=myos-app
SRC_BUN=/root/.bun/bin/bun
BUN=/usr/local/bin/bun
DROPIN_DIR=/etc/systemd/system/$UNIT.service.d
DROPIN=$DROPIN_DIR/20-service-identity.conf
LOGIN_URL=${LOGIN_URL:-http://127.0.0.1:3000/login}

install_prereqs() {
  echo "=== prerequisites (additive) ==="
  if ! cmp -s "$SRC_BUN" "$BUN" 2>/dev/null; then
    install -o root -g root -m 0755 "$SRC_BUN" "$BUN"
    echo "  $BUN installed ($($BUN --version))"
  fi
  if ! getent passwd "$SVC_USER" >/dev/null; then
    useradd --system --home-dir "/var/lib/$SVC_USER" --no-create-home \
      --shell /usr/sbin/nologin "$SVC_USER"
    echo "  created system user $SVC_USER"
  fi
}

preflight() {
  echo "=== preflight ==="
  local who=$SVC_USER
  getent passwd "$who" >/dev/null || { echo "  (no $SVC_USER yet — checks run as nobody)"; who=nobody; }
  local ok=1
  runuser -u "$who" -- "$BUN" --version >/dev/null 2>&1 \
    && echo "  ok: $who can run $BUN" || { echo "  FAIL: $who cannot run $BUN"; ok=0; }
  runuser -u "$who" -- test -r "$APP_DIR/.next/BUILD_ID" \
    && echo "  ok: $who can read the build" || { echo "  FAIL: $who cannot read $APP_DIR/.next"; ok=0; }
  runuser -u "$who" -- test -r "$APP_DIR/.env" \
    && echo "  ok: $who can read apps/app/.env (public values only)" \
    || { echo "  FAIL: $who cannot read $APP_DIR/.env"; ok=0; }
  runuser -u "$who" -- test -r /opt/myos/node_modules/next/package.json \
    && echo "  ok: $who can read node_modules" || { echo "  FAIL: node_modules not readable"; ok=0; }
  [ "$ok" = 1 ] || { echo "PREFLIGHT FAILED — nothing switched."; exit 1; }
  echo "preflight passed"
}

write_dropin() {
  mkdir -p "$DROPIN_DIR"
  cat > "$DROPIN" <<EOF
# Installed by deploy/79-app-identity.sh (audit D-02). Delete to revert.
[Service]
User=${SVC_USER}
Group=${SVC_USER}
ExecStart=
ExecStart=${BUN} run start
Environment=HOME=/var/lib/${SVC_USER}
Environment=NEXT_TELEMETRY_DISABLED=1
StateDirectory=${SVC_USER}
# As root (+), on every start: a rebuild recreates .next root-owned.
ExecStartPre=+/usr/bin/install -d -o ${SVC_USER} -g ${SVC_USER} ${APP_DIR}/.next/cache/fetch-cache ${APP_DIR}/.next/cache/images
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/.next/cache
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

rollback() {
  rm -f "$DROPIN"
  systemctl daemon-reload
  systemctl restart "$UNIT"
  echo APP_IDENTITY_ROLLED_BACK
}

case "$MODE" in
  preflight)
    preflight
    echo "Re-run with --apply to install bun, the user and the drop-in."
    ;;
  --apply)
    install_prereqs
    preflight
    write_dropin
    systemctl daemon-reload
    systemctl restart "$UNIT"
    for i in $(seq 1 90); do curl -fsS --max-time 3 -o /dev/null "$LOGIN_URL" && break; sleep 1; done
    if systemctl is-active --quiet "$UNIT" && curl -fsS --max-time 5 -o /dev/null "$LOGIN_URL"; then
      echo "  $UNIT runs as $(systemctl show -p User --value "$UNIT"); $LOGIN_URL ok"
      echo APP_IDENTITY_APPLIED
    else
      echo "  FAIL: $UNIT did not serve $LOGIN_URL — rolling back"
      rollback
      exit 1
    fi
    ;;
  --rollback)
    rollback
    ;;
  *)
    echo "usage: $0 [--apply|--rollback]" >&2
    exit 2
    ;;
esac
