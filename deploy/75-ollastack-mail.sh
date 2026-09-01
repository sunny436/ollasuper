#!/usr/bin/env bash
# Provision Ollastack Agent Mail as OllaSuper's outbound transport.
#
# WHY THIS EXISTS. Production has been running SCHEDULED_EMAIL_TRANSPORT=smtp
# against SMTP_HOST=172.18.0.1:1025 — the Mailpit container, a local catcher.
# Every auth code and every scheduled report has been landing there and going no
# further, while the delivery state machine recorded `accepted`. deploy/71 was
# supposed to refuse exactly that and did not, so the refusal now also lives in
# the code (convex/email.ts:smtpTransportAllowed) and this script repairs the
# deploy-time guard as well.
#
# WHAT IT DOES NOT DO. It never invents the API token — same rule as
# OPENROUTER_API_KEY — and it never flips a transport. Arming the transport is a
# separate, reviewed step, printed at the end.
#
# FREE TIER. Sends are uncapped (sendQuota 0) and the sender domain is the
# shared platform domain, e.g. auth@agent.ollastack.com. To move to
# mail.ollasuper.com later: verify the domain in the Ollastack dashboard (it is
# a paid, operator-gated step — the API token cannot do it), then set
# OLLASTACK_MAIL_DOMAIN in the secret file and re-run this script. No code
# change and no application redeploy.
#
# Idempotent: existing mailboxes are reused by handle, never recreated.
set -euo pipefail

REPO=${REPO:-/opt/myos}
BACKEND="$REPO/packages/backend"
SECRETS=${SECRETS:-/root/ollastack.env}
BASE_URL=${OLLASTACK_MAIL_BASE_URL:-https://login.ollastack.com}
NODE=${NODE:-/usr/bin/node}
CVX=${CVX:-$REPO/node_modules/convex/bin/main.js}

[ -d "$BACKEND" ] || { echo "FATAL: $BACKEND missing" >&2; exit 1; }
command -v curl >/dev/null || { echo "FATAL: curl is required" >&2; exit 1; }
command -v jq   >/dev/null || { echo "FATAL: jq is required (apt-get install -y jq)" >&2; exit 1; }

echo "[1/6] operator-supplied token"
# Created on first run with an empty value, exactly like services/ai/.env, so an
# operator has an obvious place to paste it and the script hard-fails until they
# do. The token is a bearer credential for sending mail as OllaSuper.
if [ ! -f "$SECRETS" ]; then
  cat > "$SECRETS" <<'EOF'
# Ollastack Agent Mail. Mint at https://login.ollastack.com with scopes
# mail.agent:read + mail.agent:write + mail.agent:send. Shown once.
OLLASTACK_MAIL_TOKEN=
# Leave EMPTY on the free tier. Set to a verified custom sender domain
# (e.g. mail.ollasuper.com) only after verifying it in the Ollastack dashboard.
OLLASTACK_MAIL_DOMAIN=
EOF
  chmod 600 "$SECRETS"; chown root:root "$SECRETS"
  echo "FATAL: created $SECRETS — paste OLLASTACK_MAIL_TOKEN into it, then re-run." >&2
  exit 1
fi
chmod 600 "$SECRETS"; chown root:root "$SECRETS"
# shellcheck disable=SC1090
set -a; . "$SECRETS"; set +a

if [ -z "${OLLASTACK_MAIL_TOKEN:-}" ]; then
  echo "FATAL: set OLLASTACK_MAIL_TOKEN in $SECRETS, then re-run." >&2
  exit 1
fi

# The token is passed via a header FILE, never on the command line: argv is
# world-readable through /proc on this box.
HDR=$(mktemp); trap 'rm -f "$HDR"' EXIT
chmod 600 "$HDR"
printf 'Authorization: Bearer %s\n' "$OLLASTACK_MAIL_TOKEN" > "$HDR"

api() { # api <method> <path> [json-body]
  if [ -n "${3:-}" ]; then
    curl -sS -X "$1" -H @"$HDR" -H 'Content-Type: application/json' \
      --max-time 30 -d "$3" "$BASE_URL$2"
  else
    curl -sS -X "$1" -H @"$HDR" --max-time 30 "$BASE_URL$2"
  fi
}

echo "[2/6] plan, quota and sender domains"
USAGE=$(api GET /api/mailboxes/usage)
echo "$USAGE" | jq -e '.success == true' >/dev/null 2>&1 || {
  echo "FATAL: could not read /api/mailboxes/usage — is the token valid?" >&2
  echo "$USAGE" | head -c 300 >&2; echo >&2
  exit 1
}
PLAN=$(echo "$USAGE" | jq -r '.data.plan // "unknown"')
SENT=$(echo "$USAGE" | jq -r '.data.sent // 0')
SEND_QUOTA=$(echo "$USAGE" | jq -r '.data.sendQuota // 0')
AGENT_DOMAIN=$(echo "$USAGE" | jq -r '.data.agentDomain // empty')
BYO_DOMAIN=$(echo "$USAGE" | jq -r '.data.byoDomain // empty')
echo "  plan=$PLAN  sent=$SENT  sendQuota=$SEND_QUOTA (0 = uncapped)"
echo "  agentDomain=${AGENT_DOMAIN:-<none>}  byoDomain=${BYO_DOMAIN:-<none>}"

[ -n "$AGENT_DOMAIN" ] || { echo "FATAL: agent mail is not enabled on this account." >&2; exit 1; }

# A capped plan that is already close to its ceiling would start dropping auth
# codes mid-month. Warn loudly rather than discovering it from a support ticket.
if [ "$SEND_QUOTA" != "0" ] && [ "$SENT" -ge $(( SEND_QUOTA * 80 / 100 )) ]; then
  echo "  WARNING: ${SENT}/${SEND_QUOTA} sends used this month — auth email will stop at the cap." >&2
fi

# The BYO domain must be VERIFIED before it can be used, and only the dashboard
# can verify it. Refuse rather than silently falling back to the shared domain,
# which would send user-facing mail from an address nobody expects.
DOMAIN_ARG=""
if [ -n "${OLLASTACK_MAIL_DOMAIN:-}" ]; then
  if [ "$OLLASTACK_MAIL_DOMAIN" != "$BYO_DOMAIN" ]; then
    echo "FATAL: OLLASTACK_MAIL_DOMAIN=$OLLASTACK_MAIL_DOMAIN is not the account's" >&2
    echo "       verified sender domain (byoDomain=${BYO_DOMAIN:-<none>})." >&2
    echo "       Verify it in the Ollastack dashboard first — the API token cannot." >&2
    exit 1
  fi
  DOMAIN_ARG="$OLLASTACK_MAIL_DOMAIN"
  echo "  using verified custom domain: $DOMAIN_ARG"
else
  echo "  using the shared platform domain: $AGENT_DOMAIN"
fi

echo "[3/6] mailboxes (reused by handle; created only if absent)"
EXISTING=$(api GET '/api/mailboxes?limit=100')

# Separate mailboxes so a report bounce-storm cannot poison auth deliverability,
# and so the From line means something to the recipient. If the plan cap refuses
# one, we degrade instead of failing: reports fall back to the auth mailbox.
ensure_mailbox() { # ensure_mailbox <handle> ; echoes the mailbox id or empty
  local handle="$1" id body
  id=$(echo "$EXISTING" | jq -r --arg h "$handle" \
    '.data.mailboxes[]? | select((.address // "") | startswith($h + "@")) | .id' | head -1)
  if [ -n "$id" ]; then
    echo "  $handle: reusing $id" >&2
    printf '%s' "$id"; return 0
  fi
  if [ -n "$DOMAIN_ARG" ]; then
    body=$(jq -nc --arg n "myos-$handle" --arg h "$handle" --arg d "$DOMAIN_ARG" \
      '{name:$n, mode:"agent", handle:$h, domain:$d}')
  else
    body=$(jq -nc --arg n "myos-$handle" --arg h "$handle" \
      '{name:$n, mode:"agent", handle:$h}')
  fi
  local res; res=$(api POST /api/mailboxes "$body")
  id=$(echo "$res" | jq -r '.data.id // empty')
  if [ -z "$id" ]; then
    echo "  $handle: NOT created — $(echo "$res" | jq -rc '.error // .' | head -c 200)" >&2
    printf ''; return 0
  fi
  echo "  $handle: created $id ($(echo "$res" | jq -r '.data.address // "?"'))" >&2
  printf '%s' "$id"
}

AUTH_ID=$(ensure_mailbox auth)
[ -n "$AUTH_ID" ] || { echo "FATAL: could not create the auth mailbox." >&2; exit 1; }
REPORTS_ID=$(ensure_mailbox reports)
if [ -z "$REPORTS_ID" ]; then
  echo "  WARNING: reports mailbox unavailable (plan cap?) — sharing the auth mailbox." >&2
  REPORTS_ID="$AUTH_ID"
fi
E2E_ID=$(ensure_mailbox e2e)
[ -n "$E2E_ID" ] || echo "  WARNING: no e2e mailbox — e2e/p2-auth.js will fall back to Mailpit." >&2

echo "[4/6] Convex deployment env"
cd "$BACKEND"
setenv() { "$NODE" "$CVX" env set -- "$1" "$2" >/dev/null && echo "  $1 set"; }
setenv OLLASTACK_MAIL_TOKEN "$OLLASTACK_MAIL_TOKEN"
setenv OLLASTACK_MAIL_BASE_URL "$BASE_URL"
setenv OLLASTACK_AUTH_MAILBOX_ID "$AUTH_ID"
setenv OLLASTACK_REPORTS_MAILBOX_ID "$REPORTS_ID"
[ -n "$E2E_ID" ] && setenv OLLASTACK_E2E_MAILBOX_ID "$E2E_ID"

echo "[5/6] transports are NOT flipped here"
AUTH_T=$("$NODE" "$CVX" env get AUTH_EMAIL_TRANSPORT 2>/dev/null || true)
RPT_T=$("$NODE" "$CVX" env get SCHEDULED_EMAIL_TRANSPORT 2>/dev/null || true)
echo "  AUTH_EMAIL_TRANSPORT=${AUTH_T:-<unset, defaults to smtp>}"
echo "  SCHEDULED_EMAIL_TRANSPORT=${RPT_T:-<unset, defaults to disabled>}"

echo "[6/6] next steps, in this order"
cat <<EOF

  Nothing sends differently yet. Arm it deliberately:

  1. Smoke test — zero user impact. Sends one real email through the deployed
     action, so transport, sender domain and INBOX-vs-SPAM placement are proven
     before any user flow depends on them. Do a Gmail address AND an Outlook one:

       cd $BACKEND
       $NODE $CVX env set SCHEDULED_EMAIL_TRANSPORT ollastack
       $NODE $CVX run --push email:sendReportEmail '{"to":"you@gmail.com","title":"OllaSuper smoke","outcome":"succeeded","markdown":"# It works","idempotencyKey":"smoke-1"}'

  2. AUTH — the live defect. Real users cannot verify or reset today:
       $NODE $CVX env set AUTH_EMAIL_TRANSPORT ollastack
     Then verify signup + verification + password reset in headed Chrome.

  3. REPORTS — already set in step 1; run a scheduled task with attachPdf and
     confirm the PDF arrives.

  ROLLBACK IS NEVER 'smtp' ON THIS HOST — smtp is Mailpit, and routing real
  user mail into a local catcher is what we are fixing. Reports roll back with
  SCHEDULED_EMAIL_TRANSPORT=disabled (recorded as skipped, report still in-app).
  Auth has no fallback: it fails visibly and is fixed forward.

EOF
echo "OLLASTACK_MAIL_DONE"
