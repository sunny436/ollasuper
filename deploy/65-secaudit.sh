#!/usr/bin/env bash
# 65 — Local repositories for security audits (services/ai/app/secaudit).
#
# Idempotent. Creates the two roots the AI plane may audit when
# AI_SECURITY_LOCAL_ROOTS names them, and nothing else:
#
#   /opt/secaudit/ollasuper  a git clone of the DEPLOYED commit. Tracked files
#                            only — no .env, no docker volumes, no credentials.
#                            Stays READ-ONLY to myos-ai (ProtectSystem=strict).
#   /opt/secaudit/fixture    the deliberately vulnerable test repository from
#                            qa/secaudit_fixture.py, regenerated on every run. The
#                            ONLY path the drop-in below makes writable, so an
#                            approved fix can be exercised without the plane ever
#                            being able to write anywhere else.
#
# The flag and allowlist live in services/ai/.env (set by the operator):
#   AI_SECURITY_ENABLED=true
#   AI_SECURITY_LOCAL_ROOTS='{"ollasuper":"/opt/secaudit/ollasuper","fixture":"/opt/secaudit/fixture"}'
#   AI_SECURITY_LOCAL_USER_IDS=<comma-separated user ids>
set -euo pipefail

REPO=/opt/myos
AI=/opt/myos/services/ai
ROOT=/opt/secaudit

install -d -m 0755 "$ROOT"

commit=$(git -C "$REPO" rev-parse HEAD)
if [ ! -d "$ROOT/ollasuper/.git" ]; then
  git clone -q --no-hardlinks "$REPO" "$ROOT/ollasuper"
fi
git -C "$ROOT/ollasuper" fetch -q "$REPO" "$commit"
git -C "$ROOT/ollasuper" checkout -q --detach "$commit"
git -C "$ROOT/ollasuper" clean -qfdx

rm -rf "$ROOT/fixture"
(cd "$AI" && .venv/bin/python -m qa.secaudit_fixture "$ROOT/fixture" >/dev/null)

install -d -m 0755 /etc/systemd/system/myos-ai.service.d
cat > /etc/systemd/system/myos-ai.service.d/secaudit.conf <<'EOF'
[Service]
# Security audits: only the test fixture is writable (approved fixes). Every other
# path stays read-only under ProtectSystem=strict.
ReadWritePaths=/opt/secaudit/fixture
EOF
systemctl daemon-reload

echo "secaudit roots ready: ollasuper@${commit:0:12}, fixture (restart myos-ai to apply the drop-in)"
