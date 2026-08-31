#!/usr/bin/env bash
# Every deploy script must be executable IN GIT, not just on someone's disk.
#
# WHY. deploy/backup.sh was tracked as 100644. deploy/61-backups.sh ran
# `chmod +x` at install time, which worked — until the next `git reset --hard`
# on the VM put the mode back. The nightly cron then failed with
# `/bin/sh: /opt/myos/deploy/backup.sh: Permission denied` every night for 13
# nights, and production went 12 days with no recovery point while the cron
# entry sat there looking installed.
#
# A chmod in an installer cannot survive a checkout. The mode has to be in the
# index, and something has to notice when it is not.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

pass=0; fail=0
ok(){ pass=$((pass+1)); echo "PASS  $1"; }
no(){ fail=$((fail+1)); echo "FAIL  $1 — ${2:-}"; }

command -v git >/dev/null 2>&1 || { echo "SKIP  no git available"; exit 0; }

echo "=== deploy/*.sh are executable in the git index ==="
bad=$(git ls-files -s 'deploy/*.sh' | awk '$1!="100755"{print $4" (mode "$1")"}')
if [ -z "$bad" ]; then
  ok "every tracked deploy script is mode 100755"
else
  no "every tracked deploy script is mode 100755" "$(echo "$bad" | tr '\n' ' ')"
fi

echo "=== every script has a shebang ==="
missing=""
while IFS= read -r f; do
  head -1 "$f" | grep -q '^#!' || missing="$missing $f"
done < <(git ls-files 'deploy/*.sh')
if [ -z "$missing" ]; then ok "every deploy script starts with a shebang"
else no "every deploy script starts with a shebang" "$missing"; fi

echo "=== every script parses ==="
broken=""
while IFS= read -r f; do
  bash -n "$f" 2>/dev/null || broken="$broken $f"
done < <(git ls-files 'deploy/*.sh')
if [ -z "$broken" ]; then ok "every deploy script passes bash -n"
else no "every deploy script passes bash -n" "$broken"; fi

echo "=== the backup cron does not depend on the exec bit alone ==="
# Belt and braces: even with the mode fixed in git, invoking through bash means
# a future regression degrades to nothing instead of to silence.
if grep -qE 'echo "\$SCHEDULE bash \$BIN' deploy/61-backups.sh; then
  ok "the installed cron line invokes the script through bash"
else
  no "the cron line invokes through bash" "a mode regression would silently stop backups again"
fi

echo
echo "===== DEPLOY MODES: $pass passed, $fail failed ====="
[ "$fail" -eq 0 ]
