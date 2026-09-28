#!/usr/bin/env bash
# The restore drill, end to end, in one command (as root, on the VM):
#
#   bash deploy/staging/drill.sh            # build, restore, verify, DESTROY
#   KEEP=1 bash deploy/staging/drill.sh     # leave staging up (for e2e runs)
#   STAGING_REF=staging bash deploy/staging/drill.sh   # a branch, not main
#
# From nothing: `down` any old stack, `up` a fresh one, `restore` the newest
# backup set (its table counts are checked BEFORE any code is deployed, when
# nothing can have moved a row), `deploy`, `verify`. Writes
# /var/lib/myos-backup/restore-drill.json, which the host monitor alerts on
# when it is missing, failed or older than 35 days: run this monthly.
#
# Staging holds a full copy of production data and ~4 GB of this host's disk,
# so it is destroyed at the end unless KEEP=1. Measured: 155 s end to end.
set -uo pipefail
export STAGING_REF=${STAGING_REF:-main}
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# `down` deletes the staging checkout, so run the lifecycle from a copy.
cp "$here/staging.sh" "$here/verify-restore.sh" "$here/verify-restore.mjs" "$tmp/"
bash "$tmp/staging.sh" down || exit 1
bash "$tmp/staging.sh" up || exit 1
bash "$tmp/staging.sh" code || exit 1
S=/opt/myos-staging/src/deploy/staging/staging.sh
bash "$S" restore || exit 1
bash "$S" deploy || exit 1
bash "$S" verify
rc=$?
if [ "${KEEP:-0}" != 1 ]; then bash "$tmp/staging.sh" down; fi
exit $rc
