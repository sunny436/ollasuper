#!/usr/bin/env bash
# Install and start the Python AI inference plane.
#
# Follows the existing deploy conventions: idempotent secret generation in the
# style of setup.sh step [6], Node (never Bun) for the Convex CLI, and a
# systemd unit modelled on myos-echo.service.
set -euo pipefail

REPO=${REPO:-/opt/myos}
AI="$REPO/services/ai"
NODE=/usr/bin/node
CVX="$REPO/node_modules/convex/bin/main.js"
HOST=${HOST:-172.16.70.25}

echo "[1/5] uv (single static binary, brings its own CPython 3.12)"
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

# uv defaults to installing its CPython under $HOME/.local/share/uv/python, and
# .venv/bin/python is a SYMLINK into it. myos-ai.service sets ProtectHome=true,
# which hides /root from the service — so systemd cannot exec the interpreter and
# the unit dies with status=203/EXEC while the same path runs fine from a shell.
# Keep the hardening and move the interpreter instead: anywhere outside $HOME.
export UV_PYTHON_INSTALL_DIR=${UV_PYTHON_INSTALL_DIR:-/opt/uv-python}

echo "[2/5] venv + deps, reproducible from uv.lock (python under $UV_PYTHON_INSTALL_DIR)"
cd "$AI"
uv python install 3.12
uv sync --frozen --no-dev

# Fail loudly here rather than as an opaque 203/EXEC after [5/5].
VENV_PY=$(readlink -f "$AI/.venv/bin/python")
case "$VENV_PY" in
  "$HOME"/*) echo "FATAL: venv interpreter is $VENV_PY, inside \$HOME; ProtectHome=true in myos-ai.service will make systemd fail to exec it. Remove $AI/.venv and re-run." >&2; exit 1 ;;
  *) echo "  interpreter: $VENV_PY" ;;
esac

echo "[2b/5] LibreOffice for the documents capability (Writer AND Impress)"
# Both components, always: the first VM had only Impress, and DOCX → PDF failed
# silently ("source file could not be loaded") until Writer was added by hand on
# 19-09-2026. /readyz reports `documents.{binary,writer,impress}` and refuses
# readiness when AI_DOCUMENTS_SOFFICE_ENABLED=true with a component missing.
if command -v apt-get >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libreoffice-impress libreoffice-writer >/dev/null
  for lib in libswlo.so libsdlo.so; do
    [ -e "/usr/lib/libreoffice/program/$lib" ] || { echo "FATAL: LibreOffice component $lib missing after install" >&2; exit 1; }
  done
  echo "  soffice: $(command -v soffice) (writer + impress present)"
fi

echo "[3/5] secrets (idempotent — never clobbers an existing .env)"
if [ ! -f "$AI/.env" ]; then
  cat > "$AI/.env" <<EOF
# 0.0.0.0, not loopback: the self-hosted Convex backend runs on the bridge
# network and reaches the AI plane over the bridge gateway, which requires the
# AI plane to listen on a non-loopback interface. ufw (deploy/62) restricts
# :8770 to the 172.18.0.0/16 bridge subnet, so this is not a public exposure.
AI_BIND_HOST=0.0.0.0
AI_PORT=8770
AI_SERVICE_KEY=$(openssl rand -hex 24)
AI_INGRESS_SECRET=$(openssl rand -hex 24)
CONVEX_SITE_URL=http://${HOST}:3211
CONVEX_INTERNAL_URL=http://127.0.0.1:3211
CONVEX_AUDIENCE=convex
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OLLIMA_API_KEY=
OLLIMA_BASE_URL=https://api.ollima.com/v1
AI_DEFAULT_MODEL=gpt-5.6-luna
AI_MAX_OUTPUT_TOKENS=8192
AI_CONTEXT_BUDGET_TOKENS=32000
AI_FLUSH_MIN_INTERVAL_MS=300
AI_FLUSH_MAX_INTERVAL_MS=700
AI_FLUSH_MIN_CHARS=96
AI_MAX_CONCURRENT_PER_USER=2
AI_MAX_CONCURRENT_GLOBAL=32
AI_PDF_ENGINE=pypdf
AI_LOG_LEVEL=INFO
AI_LOG_CONTENT=0
LANGSMITH_TRACING=false
EOF
  echo "  wrote $AI/.env with fresh secrets"
else
  echo "  $AI/.env exists — leaving it alone"
fi
chmod 600 "$AI/.env"
chown root:root "$AI/.env"

# shellcheck disable=SC1091
set -a; . "$AI/.env"; set +a

# The OpenRouter key this script must never invent (embeddings, title-gen, OCR).
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "FATAL: set OPENROUTER_API_KEY in $AI/.env, then re-run." >&2
  exit 1
fi
# The Ollima key (user-chat generation) — same rule, never invented.
if [ -z "${OLLIMA_API_KEY:-}" ]; then
  echo "FATAL: set OLLIMA_API_KEY in $AI/.env, then re-run." >&2
  exit 1
fi

echo "[4/5] Convex deployment env"
cd "$REPO/packages/backend"
# The Convex backend dispatches to the AI plane FROM INSIDE its bridge-network
# container, where 127.0.0.1 is the container itself — so it must target the
# bridge gateway (the host, from the container's view), not loopback. Derive it
# from the self-hosted network; fall back to the pinned subnet gateway.
AI_GW=$(docker network inspect self-hosted_default \
  --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)
[ -n "$AI_GW" ] || AI_GW=172.18.0.1
"$NODE" "$CVX" env set -- AI_BASE_URL       "http://${AI_GW}:8770" >/dev/null
"$NODE" "$CVX" env set -- AI_SERVICE_KEY    "$AI_SERVICE_KEY"       >/dev/null
"$NODE" "$CVX" env set -- AI_INGRESS_SECRET "$AI_INGRESS_SECRET"    >/dev/null
"$NODE" "$CVX" deploy -y

echo "[5/5] systemd"
sed "s|/opt/myos|$REPO|g" "$AI/systemd/myos-ai.service" \
  > /etc/systemd/system/myos-ai.service
systemctl daemon-reload
systemctl enable --now myos-ai.service

sleep 3
curl -fsS http://127.0.0.1:8770/healthz >/dev/null && echo "  healthz OK"
curl -fsS http://127.0.0.1:8770/readyz  >/dev/null && echo "  readyz OK"
echo "AI_DEPLOY_DONE"
