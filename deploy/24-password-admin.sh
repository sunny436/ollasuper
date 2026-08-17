#!/usr/bin/env bash
# Deploy Password provider and create a test admin (email+password). Verify sign-in.
set -uo pipefail
# The admin password is never defaulted here. It used to be a literal, which put a
# working production credential in a public repo; see e2e/*.js for the same fix.
# Same shape as OPENROUTER_API_KEY in 54-ai-service.sh: hard-fail until supplied.
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@myos.test}
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  echo "FATAL: export ADMIN_PASSWORD (and optionally ADMIN_EMAIL) before running this." >&2
  exit 1
fi
NODE=/usr/bin/node
CVX=/opt/myos/node_modules/convex/bin/main.js
cp /tmp/auth.ts /opt/myos/packages/backend/convex/auth.ts
cd /opt/myos/packages/backend

echo "=== deploy (password provider) ==="
"$NODE" "$CVX" deploy -y 2>&1 | tail -5

echo "=== create admin (signUp) ==="
"$NODE" "$CVX" run auth:signIn "{\"provider\":\"password\",\"params\":{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"flow\":\"signUp\"}}" 2>&1 | tail -6 || echo "(signUp failed — may already exist)"

echo "=== verify admin sign-in (signIn) ==="
"$NODE" "$CVX" run auth:signIn "{\"provider\":\"password\",\"params\":{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"flow\":\"signIn\"}}" 2>&1 | tail -6

echo "=== admin user row ==="
"$NODE" "$CVX" data users 2>&1 | grep "$ADMIN_EMAIL" || echo NO_ADMIN
echo "PWADMIN_DONE"
