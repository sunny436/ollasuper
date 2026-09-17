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

# --- Deterministic scanners (AI_SECURITY_SCANNER_BIN_DIR=/opt/secaudit/bin) ------
# Pinned versions, sha256-verified; a mismatch aborts before anything is replaced.
# /opt/secaudit/bin is outside ReadWritePaths, so the plane can run but never
# modify them. OpenGrep uses the first-party ruleset in app/secaudit/rules (the
# community opengrep-rules repo carries a Commons Clause restriction). Gitleaks
# runs with its own pinned default config so a scanned repository's
# .gitleaks.toml cannot turn detection off.
BIN="$ROOT/bin"
OPENGREP_VERSION=v1.30.0
OPENGREP_SHA256=35779bdd72e92129c8df2a77f0c55e8c08356801ea92591ef32108d6b28d564c
GITLEAKS_VERSION=8.30.1
GITLEAKS_TGZ_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
GITLEAKS_TOML_SHA256=e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf
install -d -m 0755 "$BIN"

fetch_verified() { # url dest sha256 mode
  if [ -f "$2" ] && echo "$3  $2" | sha256sum -c --quiet 2>/dev/null; then return 0; fi
  tmp=$(mktemp)
  curl -fsSL -m 300 -o "$tmp" "$1"
  if ! echo "$3  $tmp" | sha256sum -c --quiet; then
    rm -f "$tmp"; echo "checksum mismatch: $1" >&2; exit 1
  fi
  install -m "$4" "$tmp" "$2"; rm -f "$tmp"
}

fetch_verified "https://github.com/opengrep/opengrep/releases/download/$OPENGREP_VERSION/opengrep_manylinux_x86" \
  "$BIN/opengrep" "$OPENGREP_SHA256" 0755
if ! { [ -x "$BIN/gitleaks" ] && [ "$("$BIN/gitleaks" version)" = "$GITLEAKS_VERSION" ]; }; then
  tmpd=$(mktemp -d)
  curl -fsSL -m 300 -o "$tmpd/gl.tgz" \
    "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  if ! echo "$GITLEAKS_TGZ_SHA256  $tmpd/gl.tgz" | sha256sum -c --quiet; then
    rm -rf "$tmpd"; echo "checksum mismatch: gitleaks $GITLEAKS_VERSION" >&2; exit 1
  fi
  tar xzf "$tmpd/gl.tgz" -C "$tmpd" gitleaks
  install -m 0755 "$tmpd/gitleaks" "$BIN/gitleaks"; rm -rf "$tmpd"
fi
fetch_verified "https://raw.githubusercontent.com/gitleaks/gitleaks/v$GITLEAKS_VERSION/config/gitleaks.toml" \
  "$BIN/gitleaks.toml" "$GITLEAKS_TOML_SHA256" 0644
echo "scanners: opengrep $("$BIN/opengrep" --version) · gitleaks $("$BIN/gitleaks" version)"

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
