#!/usr/bin/env bash
# Enable Google sign-in. Idempotent; re-runnable.
#
# The provider code already exists (authPolicy.googleProfile enforces
# email_verified and binds identity to the immutable `sub`); this only supplies
# credentials and makes the OIDC issuer publicly resolvable.
#
# WHY THE ISSUER MOVES: Google redirects the user's BROWSER to the callback, so
# CONVEX_SITE_URL cannot stay on loopback. Changing it re-issues under a new
# issuer, so EVERY EXISTING SESSION IS INVALIDATED once. That is unavoidable.
#
# Credentials are never defaulted here — same rule as OPENROUTER_API_KEY in
# 54-ai-service.sh.
set -uo pipefail
REPO=${REPO:-/opt/myos}
C="node $REPO/node_modules/convex/bin/main.js"
SITE=${CONVEX_PUBLIC_SITE_URL:-https://app.ollasuper.com/__cvx-site}

if [ -z "${AUTH_GOOGLE_ID:-}" ] || [ -z "${AUTH_GOOGLE_SECRET:-}" ]; then
  echo "FATAL: export AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET before running this." >&2
  echo "  Register this exact redirect URI in Google Cloud Console:" >&2
  echo "    $SITE/api/auth/callback/google" >&2
  exit 1
fi

cd "$REPO/packages/backend" || exit 1
echo "=== credentials ==="
$C env set AUTH_GOOGLE_ID     "$AUTH_GOOGLE_ID"     >/dev/null && echo "  id set"
$C env set AUTH_GOOGLE_SECRET "$AUTH_GOOGLE_SECRET" >/dev/null && echo "  secret set"

echo "=== issuer -> $SITE (invalidates all sessions) ==="
$C env set CONVEX_SITE_URL "$SITE" >/dev/null
sed -i "s#^CONVEX_SITE_ORIGIN=.*#CONVEX_SITE_ORIGIN=$SITE#" "$REPO/self-hosted/.env"
( cd "$REPO/self-hosted" && docker compose up -d ) >/dev/null 2>&1
sleep 8

echo "=== deploy ==="; $C deploy -y 2>&1 | tail -2

echo "=== verify ==="
curl -s -o /dev/null -w "  public openid-configuration: %{http_code}\n" --max-time 20 "$SITE/.well-known/openid-configuration"
CID=$(cd "$REPO/self-hosted" && docker compose ps -q backend | head -1)
# The hairpin: the backend must resolve its own issuer out through Cloudflare and
# back in. deploy/28-fix-issuer.sh exists because this broke against a
# self-signed cert; a real certificate is what makes it work.
docker exec "$CID" sh -c "curl -s -o /dev/null -w '  container -> issuer: %{http_code}\n' --max-time 15 $SITE/.well-known/openid-configuration"
echo -n "  signIn(google) redirect: "
$C run auth:signIn '{"provider":"google"}' 2>/dev/null | grep -oE 'https://[^"]+' | head -1 | cut -c1-60
echo "GOOGLE_OAUTH_DONE"
