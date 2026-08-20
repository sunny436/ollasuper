#!/usr/bin/env bash
# Provision the dedicated pgvector database for the File Knowledge System.
#
# A standalone `pgvector/pgvector:pg16` container (services/ai/compose.knowledge.yml),
# NOT an extension installed into Convex's live host Postgres. Rationale: isolate a
# heavy HNSW build / a bad migration from `convex_self_hosted` (the highest-risk
# surface), and pin pgvector >= 0.8 which the tenant-filtered retrieval query needs
# (hnsw.iterative_scan). Idempotent: safe to re-run.
set -euo pipefail

REPO=${REPO:-/opt/myos}
AI="$REPO/services/ai"
COMPOSE="$AI/compose.knowledge.yml"
ENVF="$AI/.env"
IMG_TAG=${KNOWLEDGE_DB_IMAGE_TAG:-pgvector/pgvector:pg16}

[ -f "$ENVF" ] || { echo "FATAL: $ENVF missing — run deploy/54-ai-service.sh first" >&2; exit 1; }
[ -f "$COMPOSE" ] || { echo "FATAL: $COMPOSE missing" >&2; exit 1; }

# Append KEY=VALUE to .env only if KEY is not already present (never clobber).
add_env() {
  local key="$1" val="$2"
  if ! grep -q "^${key}=" "$ENVF"; then
    printf '%s=%s\n' "$key" "$val" >> "$ENVF"
    echo "  wrote $key"
  else
    echo "  $key already set — leaving it"
  fi
}

echo "[1/6] secret + connection URL (idempotent)"
if ! grep -q '^KNOWLEDGE_DB_PASSWORD=' "$ENVF"; then
  PW=$(openssl rand -hex 24)
  add_env KNOWLEDGE_DB_PASSWORD "$PW"
else
  PW=$(grep '^KNOWLEDGE_DB_PASSWORD=' "$ENVF" | head -1 | cut -d= -f2-)
fi
# libpq URL (psql/pg_dump/alembic/psycopg all take it as-is). sslmode=disable:
# loopback needs no TLS and the host snakeoil cert has no IP SAN anyway.
add_env KNOWLEDGE_DATABASE_URL "postgresql://myos_ai:${PW}@127.0.0.1:5433/myos_knowledge?sslmode=disable"
chmod 600 "$ENVF"; chown root:root "$ENVF"

echo "[2/6] pin the pgvector image by digest (mirrors the Convex backend pin)"
docker pull "$IMG_TAG"
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMG_TAG")
if grep -q '^KNOWLEDGE_DB_IMAGE=' "$ENVF"; then
  sed -i "s|^KNOWLEDGE_DB_IMAGE=.*|KNOWLEDGE_DB_IMAGE=${DIGEST}|" "$ENVF"
else
  printf 'KNOWLEDGE_DB_IMAGE=%s\n' "$DIGEST" >> "$ENVF"
fi
echo "  pinned $DIGEST"

echo "[3/6] start the container (loopback-published :5433)"
docker compose -f "$COMPOSE" --env-file "$ENVF" up -d

echo "[4/6] wait for healthy"
for i in $(seq 1 30); do
  state=$(docker compose -f "$COMPOSE" --env-file "$ENVF" ps --format '{{.Health}}' knowledge-db 2>/dev/null || true)
  [ "$state" = "healthy" ] && { echo "  healthy"; break; }
  [ "$i" = 30 ] && { echo "FATAL: knowledge-db never became healthy" >&2; exit 1; }
  sleep 2
done

echo "[5/6] migrations (creates extension + tables + HNSW index)"
cd "$AI"
uv sync --frozen --no-dev
set -a; . "$ENVF"; set +a
uv run alembic upgrade head

echo "[6/6] HARD GATE: pgvector >= 0.8 (hnsw.iterative_scan + halfvec)"
VER=$(docker compose -f "$COMPOSE" --env-file "$ENVF" exec -T knowledge-db \
  psql -U myos_ai -d myos_knowledge -tAc \
  "SELECT extversion FROM pg_extension WHERE extname='vector'" | tr -d '[:space:]')
[ -n "$VER" ] || { echo "FATAL: vector extension not installed" >&2; exit 1; }
if [ "$(printf '%s\n0.8.0\n' "$VER" | sort -V | head -1)" != "0.8.0" ]; then
  echo "FATAL: pgvector $VER < 0.8.0 (tenant-filtered top-K would under-fill)" >&2
  exit 1
fi
echo "  pgvector $VER OK"
echo "KNOWLEDGE_DB_DONE"
