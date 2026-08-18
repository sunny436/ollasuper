#!/usr/bin/env bash
# Stand up a Convex CLOUD deployment as a dev/staging target.
#
# THIS DOES NOT TOUCH PRODUCTION. Self-hosted production is reached through
# CONVEX_SELF_HOSTED_URL / CONVEX_SELF_HOSTED_ADMIN_KEY, which this script never
# sets and never reads; it can only ever act on the deployment named by the
# CONVEX_DEPLOY_KEY it is handed.
#
# Usage:
#   CONVEX_DEPLOY_KEY='prod:name|...' SITE_URL=https://staging.example.com \
#     ./deploy/60-convex-cloud-dev.sh
#
# Optional pass-through (set what you have; missing ones are reported, never
# invented): AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET POLAR_ORGANIZATION_TOKEN
#            POLAR_WEBHOOK_SECRET RESEND_API_KEY RESEND_SENDER_EMAIL_AUTH
#            LOOPS_FORM_ID
set -euo pipefail

REPO=${REPO:-$(cd "$(dirname "$0")/.." && pwd)}
NODE=${NODE:-/usr/bin/node}
CVX="$REPO/node_modules/convex/bin/main.js"
[ -x "$NODE" ] || NODE=$(command -v node)

# Never defaulted, never written to disk -- same rule 54-ai-service.sh applies
# to OPENROUTER_API_KEY.
if [ -z "${CONVEX_DEPLOY_KEY:-}" ]; then
  echo "FATAL: export CONVEX_DEPLOY_KEY first (Convex dashboard ->" >&2
  echo "       Settings -> Deploy Keys). Prefer a prod: key; a dev:" >&2
  echo "       deployment is per-developer scratch that 'npx convex dev'" >&2
  echo "       from any machine can overwrite." >&2
  exit 1
fi
: "${SITE_URL:?FATAL: export SITE_URL (the Next app origin, e.g. https://staging.example.com)}"

DEPLOYMENT=$(printf '%s' "$CONVEX_DEPLOY_KEY" | cut -d'|' -f1)
NAME=$(printf '%s' "$DEPLOYMENT" | cut -d':' -f2)
KIND=$(printf '%s' "$DEPLOYMENT" | cut -d':' -f1)
SITE="https://${NAME}.convex.site"

echo "=== target ==="
echo "  deployment : $DEPLOYMENT"
echo "  site       : $SITE"
[ "$KIND" = "dev" ] && echo "  WARNING: this is a DEV deployment. Fine for scratch, not for anything real."

cd "$REPO/packages/backend"
export CONVEX_DEPLOY_KEY
# Belt and braces: make sure no stray self-hosted config can redirect us.
unset CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY

echo "=== [1/5] refuse to stomp on an occupied deployment ==="
EXISTING=$("$NODE" "$CVX" data 2>/dev/null | grep -v '^\s*$' | head -20 || true)
if [ -n "$EXISTING" ] && [ "${ALLOW_NONEMPTY:-0}" != "1" ]; then
  echo "  deployment already contains tables:" >&2
  printf '%s\n' "$EXISTING" | sed 's/^/    /' >&2
  echo "  Refusing to deploy over it. This guard exists because the supplied" >&2
  echo "  dev deployment already held an unrelated table (USERs_DB)." >&2
  echo "  Re-run with ALLOW_NONEMPTY=1 only if you are certain." >&2
  exit 1
fi
echo "  empty (or override set) -- proceeding"

echo "=== [2/5] fresh JWT keypair ==="
# FRESH, never production's. Both copies of the generator exist; prefer scripts/.
GEN="$REPO/scripts/generateKeys.mjs"; [ -f "$GEN" ] || GEN="$REPO/deploy/generateKeys.mjs"
"$NODE" "$GEN"
JWKS_VAL=$(cat /tmp/jwks)
JWT_VAL=$(cat /tmp/jwt_private_key)
rm -f /tmp/jwks /tmp/jwt_private_key

# The `--` end-of-options form matters: generateKeys.mjs flattens newlines to
# spaces and the leading -----BEGIN is otherwise parsed as a CLI flag. This is
# the entire reason deploy/08b-fix-jwt.sh exists.
"$NODE" "$CVX" env set -- JWKS "$JWKS_VAL" >/dev/null && echo "  JWKS set"
if "$NODE" "$CVX" env set -- JWT_PRIVATE_KEY "$JWT_VAL" >/dev/null 2>&1; then
  echo "  JWT_PRIVATE_KEY set (-- form)"
else
  "$NODE" "$CVX" env set "JWT_PRIVATE_KEY=$JWT_VAL" >/dev/null
  echo "  JWT_PRIVATE_KEY set (NAME=VALUE fallback)"
fi

echo "=== [3/5] env ==="
"$NODE" "$CVX" env set -- SITE_URL "$SITE_URL" >/dev/null && echo "  SITE_URL=$SITE_URL"
# CONVEX_SITE_URL is deliberately NOT set: Convex injects it as a system
# variable. 04-deploy-backend.sh documents the same for self-hosted. Step 5
# verifies that rather than trusting it.
#
# VALIDATE_ENV is deliberately NOT set either: env.ts uses
# `skipValidation: !process.env.VALIDATE_ENV`, and POLAR_ORGANIZATION_TOKEN /
# POLAR_WEBHOOK_SECRET are required there but set by no script in this repo.
# Leaving it unset is what lets a dev deployment boot at all. Turn it on only
# once those two exist.
missing=()
for v in AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET POLAR_ORGANIZATION_TOKEN \
         POLAR_WEBHOOK_SECRET RESEND_API_KEY RESEND_SENDER_EMAIL_AUTH LOOPS_FORM_ID; do
  if [ -n "${!v:-}" ]; then
    "$NODE" "$CVX" env set -- "$v" "${!v}" >/dev/null && echo "  $v set"
  else
    missing+=("$v")
  fi
done
[ ${#missing[@]} -gt 0 ] && echo "  not supplied (never invented): ${missing[*]}"

echo "=== [4/5] deploy ==="
"$NODE" "$CVX" deploy -y 2>&1 | tail -4

echo "=== [5/5] verify the injected issuer actually resolves ==="
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 \
  "$SITE/.well-known/openid-configuration" || echo 000)
echo "  $SITE/.well-known/openid-configuration -> $code"
[ "$code" = "200" ] || { echo "  FATAL: issuer did not resolve; auth will not work" >&2; exit 1; }

cat <<EOF

=== next steps (manual) ===
  Google sign-in on this deployment needs this EXACT redirect URI registered
  in Google Cloud Console:
      $SITE/api/auth/callback/google

  Point a build at it with (build-time -- needs rm -rf .next + rebuild):
      NEXT_PUBLIC_CONVEX_URL=https://${NAME}.convex.cloud

  Chat GENERATION will not work here: AI_BASE_URL points at VM loopback
  (127.0.0.1:8770) and Convex Cloud cannot reach a private address. The
  catalogue, auth, threads and messages all work.
EOF
echo "CONVEX_CLOUD_DEV_OK"
