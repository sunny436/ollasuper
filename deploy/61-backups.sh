#!/usr/bin/env bash
# Install the nightly Convex backup: directory, permissions, cron, first run.
#
# WHY THIS EXISTS SEPARATELY FROM 29-fixes.sh:
#
# 29-fixes.sh is what originally installed this cron, but it is a point-in-time
# patch script, not an installer. It opens with `cp /tmp/orgs.ts` and two more
# copies from /tmp, and runs `set -uo pipefail` WITHOUT -e -- so on a VM where
# those staged files are gone, the copies fail, it carries on regardless, and
# then runs `convex deploy` against whatever happens to be on disk. Re-running
# it to get a backup cron is not safe.
#
# This script does only the backup half, and is idempotent.
#
# It was needed because the rebuilt VM never ran 29-fixes.sh: /opt/backups did
# not exist, no cron was installed, and deploy/backup.sh was not executable.
# Production had no recovery point of any kind.
set -euo pipefail

REPO=${REPO:-/opt/myos}
DEST=${BACKUP_DIR:-/opt/backups}
LOG=${BACKUP_LOG:-/var/log/myos-backup.log}
SCHEDULE=${BACKUP_SCHEDULE:-"0 3 * * *"}
BIN="$REPO/deploy/backup.sh"

[ -f "$BIN" ] || { echo "FATAL: $BIN not found" >&2; exit 1; }

echo "=== [1/4] directory + permissions ==="
mkdir -p "$DEST"
chmod +x "$BIN"
echo "  $DEST ready; $(ls -l "$BIN" | awk '{print $1}') $BIN"

echo "=== [2/4] cron ==="
# `bash "$BIN"`, NOT "$BIN" on its own.
#
# This job silently died for 13 consecutive nights with
# `/bin/sh: /opt/myos/deploy/backup.sh: Permission denied`, and production went
# 12 days with no recovery point. The chmod +x above is real but not durable:
# git tracked these scripts as 100644, so the next `git reset --hard` on the VM
# put the mode straight back and nothing re-ran this installer. The exec bit is
# now set in git too, which fixes the cause — invoking through `bash` as well
# means a future mode regression degrades to nothing at all.
( crontab -l 2>/dev/null | grep -vF "deploy/backup.sh" || true
  echo "$SCHEDULE bash $BIN >> $LOG 2>&1" ) | crontab -
echo "  installed: $(crontab -l 2>/dev/null | grep -cF 'deploy/backup.sh') entry"
crontab -l 2>/dev/null | grep -F "deploy/backup.sh" | sed 's/^/    /'

echo "=== [3/4] first run ==="
"$BIN"

echo "=== [4/4] verify the archive actually contains file storage ==="
LATEST=$(ls -1t "$DEST"/convex-*.zip 2>/dev/null | head -1)
[ -n "$LATEST" ] || { echo "FATAL: no archive produced" >&2; exit 1; }

# python3 rather than unzip: unzip is not installed on this VM.
python3 - "$LATEST" <<'PY'
import sys, zipfile
path = sys.argv[1]
with zipfile.ZipFile(path) as z:
    names = z.namelist()
storage = [n for n in names if n.startswith("_storage/")]
tables = sorted({n.split("/")[0] for n in names if not n.startswith("_storage/")})
print(f"  archive   : {path}")
print(f"  entries   : {len(names)}")
print(f"  tables    : {len(tables)}")
print(f"  _storage/ : {len(storage)} entr{'y' if len(storage)==1 else 'ies'}")
# Not fatal: a deployment with no uploaded files legitimately has none. The
# point is that the folder is now INCLUDED, so it fills as files are added.
if not storage:
    print("  note: no stored files on this deployment yet -- expected while")
    print("        files/attachments are empty. The flag is what matters.")
PY

echo "BACKUPS_INSTALLED_OK"
