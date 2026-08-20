#!/usr/bin/env bash
# Daily snapshot backup of the LIVE Convex deployment. Keeps the last 7.
#
# TARGET SELECTION (added with the Convex Cloud migration, 2026-08-18):
# production data now lives on Convex Cloud, and the self-hosted deployment is
# stopped. A backup that still pointed at self-hosted would "succeed" against a
# dead container or, worse, silently archive a frozen rollback copy while the
# real data went unprotected. So: if the Cloud deploy key is present, back up
# Cloud; otherwise fall back to self-hosted via packages/backend/.env.local.
#
# --env-file is NOT optional on the Cloud path. packages/backend/.env.local
# holds CONVEX_SELF_HOSTED_URL and takes precedence over CONVEX_DEPLOY_KEY, so
# without it the export silently targets self-hosted instead.
#
# THREE OTHER THINGS ARE DELIBERATE:
#  1. --include-file-storage. Without it the archive holds rows whose
#     users.imageId / files.storageId / chatAttachments.storageId blobs are
#     absent, i.e. stored files are unrestorable.
#  2. `set -e` is on, but the retention pipeline is explicitly tolerated: on a
#     first run the glob matches nothing, ls exits non-zero, and pipefail would
#     abort the script AFTER a perfectly good export.
#  3. Pruning happens only after the new archive is confirmed to exist and be
#     non-trivial, so a failed export can never delete the last good backup.
set -euo pipefail

DEST=${BACKUP_DIR:-/opt/backups}
REPO=${REPO:-/opt/myos}
KEEP=${BACKUP_KEEP:-7}
MIN_BYTES=${BACKUP_MIN_BYTES:-1024}
KEYFILE=${CONVEX_KEY_FILE:-/root/.cvx-cloud-key}
EMPTY=${CONVEX_EMPTY_ENV:-/root/.empty-env}

mkdir -p "$DEST"
cd "$REPO/packages/backend"

ts=$(date +%Y%m%d-%H%M%S)
out="$DEST/convex-$ts.zip"

# Node, never Bun: Bun's WebSocket client breaks against self-hosted Convex.
CVX=("/usr/bin/node" "$REPO/node_modules/convex/bin/main.js")

if [ -f "$KEYFILE" ]; then
  : > "$EMPTY"
  target="Convex Cloud"
  CONVEX_DEPLOY_KEY=$(tr -d ' \t\r\n' < "$KEYFILE") \
    "${CVX[@]}" export --env-file "$EMPTY" --include-file-storage --path "$out"
else
  target="self-hosted"
  "${CVX[@]}" export --include-file-storage --path "$out"
fi

if [ ! -f "$out" ]; then
  echo "FATAL: export of $target reported success but $out does not exist" >&2
  exit 1
fi

size=$(wc -c < "$out")
if [ "$size" -lt "$MIN_BYTES" ]; then
  echo "FATAL: $out is only ${size}B (< ${MIN_BYTES}B); refusing to prune" >&2
  exit 1
fi

ls -1t "$DEST"/convex-*.zip 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f || true

echo "backup written: $out (${size} bytes, from $target, kept last $KEEP)"

# --- File Knowledge System pgvector DB (separate container) -----------------
# The knowledge DB holds user files + embeddings and is in NO other backup.
# Custom format (-Fc) so pg_restore recreates `CREATE EXTENSION vector` and can
# restore selectively. Its own glob + retention so a Convex-export failure can
# never delete the last good DB dump, and vice-versa. Skipped if the container
# is not running (e.g. a box where deploy/70 has not run).
if docker compose -f "$REPO/services/ai/compose.knowledge.yml" ps knowledge-db 2>/dev/null | grep -q "Up\|running"; then
  kout="$DEST/knowledge-$ts.dump"
  # Peer auth inside the container — no password in argv.
  docker exec "$(docker compose -f "$REPO/services/ai/compose.knowledge.yml" ps -q knowledge-db)" \
    pg_dump -Fc -U myos_ai myos_knowledge > "$kout"
  ksize=$(wc -c < "$kout")
  if [ ! -s "$kout" ] || [ "$ksize" -lt "$MIN_BYTES" ]; then
    echo "FATAL: knowledge dump $kout is only ${ksize:-0}B; refusing to prune" >&2
    exit 1
  fi
  ls -1t "$DEST"/knowledge-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f || true
  echo "knowledge dump written: $kout (${ksize} bytes, kept last $KEEP)"
fi
