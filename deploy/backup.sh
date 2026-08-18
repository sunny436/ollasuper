#!/usr/bin/env bash
# Daily snapshot backup of the self-hosted Convex deployment. Keeps the last 7.
#
# THREE THINGS HERE ARE DELIBERATE:
#
# 1. --include-file-storage. Without it `convex export` writes rows whose
#    users.imageId / files.storageId / chatAttachments.storageId point at blobs
#    that are NOT in the archive, so avatars, workspace files and chat
#    attachments are unrestorable. Every backup taken before this flag was added
#    has that hole.
#
# 2. `set -e` is on, but the retention pipeline is explicitly tolerated. On the
#    very first run the glob matches nothing, `ls` exits non-zero, and pipefail
#    would propagate that and abort the script AFTER a perfectly good export.
#
# 3. Pruning happens only after the new archive is confirmed to exist and be
#    non-trivial. The previous version pruned unconditionally, so a week of
#    silently failing exports would have deleted the last good backup.
set -euo pipefail

DEST=${BACKUP_DIR:-/opt/backups}
REPO=${REPO:-/opt/myos}
KEEP=${BACKUP_KEEP:-7}
# A valid Convex zip is never this small; anything under it means the export
# produced a stub or an error page rather than a snapshot.
MIN_BYTES=${BACKUP_MIN_BYTES:-1024}

mkdir -p "$DEST"
cd "$REPO/packages/backend"

ts=$(date +%Y%m%d-%H%M%S)
out="$DEST/convex-$ts.zip"

# Node, never Bun: Bun's WebSocket client breaks against self-hosted Convex.
/usr/bin/node "$REPO/node_modules/convex/bin/main.js" \
  export --include-file-storage --path "$out"

if [ ! -f "$out" ]; then
  echo "FATAL: export reported success but $out does not exist" >&2
  exit 1
fi

size=$(wc -c < "$out")
if [ "$size" -lt "$MIN_BYTES" ]; then
  echo "FATAL: $out is only ${size}B (< ${MIN_BYTES}B); refusing to prune" >&2
  exit 1
fi

# Only now is it safe to drop old archives.
ls -1t "$DEST"/convex-*.zip 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f || true

echo "backup written: $out (${size} bytes, kept last $KEEP)"
