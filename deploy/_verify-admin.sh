#!/usr/bin/env bash
# One-off: verify the legacy admin account so password sign-in works under mandatory verification.
set -uo pipefail
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@myos.test}
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  echo "FATAL: export ADMIN_PASSWORD before running this." >&2
  exit 1
fi
N=/usr/bin/node; C=/opt/myos/node_modules/convex/bin/main.js
cd /opt/myos/packages/backend
OUT=$("$N" "$C" run auth:signIn "{\"provider\":\"password\",\"params\":{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"flow\":\"signIn\"}}" 2>&1)
CODE=$(printf '%s' "$OUT" | grep -oE "email verification code for $ADMIN_EMAIL: [0-9]+" | grep -oE '[0-9]+$' | tail -1)
echo "verify code=$CODE"
"$N" "$C" run auth:signIn "{\"provider\":\"password\",\"params\":{\"email\":\"$ADMIN_EMAIL\",\"code\":\"$CODE\",\"flow\":\"email-verification\"}}" 2>&1 | tail -3
echo "-- admin password sign-in now: --"
"$N" "$C" run auth:signIn "{\"provider\":\"password\",\"params\":{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"flow\":\"signIn\"}}" 2>&1 | grep -q '"token"' && echo "ADMIN_SIGNIN_OK" || echo "STILL_BLOCKED"
