#!/usr/bin/env bash
# P4 failure injection: webhook auth, OTP single-use.
set -uo pipefail
N=/usr/bin/node; C=/opt/myos/node_modules/convex/bin/main.js
cd /opt/myos/packages/backend

echo "=== [1] webhook rejects bad/missing secret ==="
curl -s -o /dev/null -w "bad-secret -> %{http_code} (expect 401)\n" -X POST http://127.0.0.1:3211/backend/webhook -H "x-webhook-secret: WRONG" -H "content-type: application/json" -d '{}'
curl -s -o /dev/null -w "no-secret  -> %{http_code} (expect 401)\n" -X POST http://127.0.0.1:3211/backend/webhook -H "content-type: application/json" -d '{}'

echo "=== [2] OTP is single-use (replay must fail) ==="
EMAIL="p4otp$$@myos.test"
OUT=$("$N" "$C" run auth:signIn "{\"provider\":\"resend-otp\",\"params\":{\"email\":\"$EMAIL\"}}" 2>&1)
CODE=$(printf '%s' "$OUT" | grep -oE "OTP for $EMAIL: [0-9]+" | grep -oE '[0-9]+$' | tail -1)
echo "code=$CODE"
echo -n "verify #1: "; "$N" "$C" run auth:signIn "{\"provider\":\"resend-otp\",\"params\":{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}}" 2>&1 | grep -qE '"token"' && echo "SUCCESS (tokens issued)" || echo "FAILED"
echo -n "verify #2 (replay): "; "$N" "$C" run auth:signIn "{\"provider\":\"resend-otp\",\"params\":{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}}" 2>&1 | grep -qE '"token"' && echo "SUCCESS (BUG: code reusable!)" || echo "rejected (good, single-use)"
echo P4_DONE
