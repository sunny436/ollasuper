// Real-inbox helper for the auth e2e scripts.
//
// WHY THIS EXISTS. p2-auth.js used to sign up as `authtest<ts>@myos.test` and
// read the code back out of Mailpit's API. That passes on a stack that cannot
// mail anyone — which is exactly what production turned out to be. Reading a
// code from a real inbox, delivered over the real transport, is the only
// version of this test that proves anything.
//
// The address uses `+tag` subaddressing on ONE persistent agent mailbox: every
// `+tag` variant routes back to the same mailbox, so a run gets an isolated
// address without minting a mailbox per run (they are plan-capped) and without
// needing a second API token.
//
// NEWEST-FIRST is load-bearing. A resend invalidates its predecessor, so an
// older code is not merely stale — it is wrong, and using it would make a
// passing test out of a broken resend.

const BASE =
  process.env.OLLASTACK_MAIL_BASE_URL || "https://login.ollastack.com";
const TOKEN = process.env.OLLASTACK_MAIL_TOKEN || "";
const MAILBOX = process.env.OLLASTACK_E2E_MAILBOX_ID || "";

/** False when the stack has no Ollastack mailbox — callers fall back to Mailpit. */
function enabled() {
  return Boolean(TOKEN && MAILBOX);
}

async function api(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`ollastack ${path} -> ${res.status}`);
  return await res.json();
}

/** The e2e mailbox's own address, e.g. e2e@agent.ollastack.com. */
async function mailboxAddress() {
  const json = await api(`/api/mailboxes/${encodeURIComponent(MAILBOX)}`);
  const address = json?.data?.address;
  if (!address) throw new Error("ollastack: mailbox has no address");
  return address;
}

/**
 * A unique recipient for this run: `e2e+<tag>@agent.ollastack.com`.
 *
 * The tag must survive the app's own email normalisation, so keep it to
 * lowercase alphanumerics.
 */
function taggedAddress(address, tag) {
  const [local, domain] = String(address).split("@");
  return `${local}+${tag}@${domain}`;
}

function newTag() {
  return `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
}

/**
 * Poll for the newest inbound message addressed to this run's tag, and return
 * the OTP the provider extracted from it.
 *
 * `codes` is populated at ingest. The list endpoint omits bodies, so when a
 * listed message carries no codes we fetch that one message rather than
 * guessing from the subject.
 */
async function codeFromOllastack(tag, subjectContains, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const qs = new URLSearchParams({
      direction: "inbound",
      limit: "25",
      tag,
    });
    let json;
    try {
      json = await api(
        `/api/mailboxes/${encodeURIComponent(MAILBOX)}/messages?${qs}`,
      );
    } catch {
      json = null;
    }
    // Newest first, per the API contract.
    const messages = json?.data?.messages ?? [];
    for (const m of messages) {
      const subject = String(m.subject ?? "");
      if (
        subjectContains &&
        !subject.toLowerCase().includes(String(subjectContains).toLowerCase())
      ) {
        continue;
      }
      let codes = Array.isArray(m.codes) ? m.codes : [];
      if (codes.length === 0) {
        try {
          const full = await api(
            `/api/mailboxes/${encodeURIComponent(MAILBOX)}/messages/${encodeURIComponent(m.id)}`,
          );
          const body = `${full?.data?.textBody ?? ""} ${full?.data?.htmlBody ?? ""}`;
          const hit = body.match(/\b(\d{6,8})\b/);
          if (hit) codes = [hit[1]];
        } catch {
          /* fall through to the next message */
        }
      }
      if (codes.length > 0) return codes[0];
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

/** Every message this run received, for assertions about content. */
async function messagesForTag(tag) {
  const qs = new URLSearchParams({ direction: "inbound", limit: "50", tag });
  const json = await api(
    `/api/mailboxes/${encodeURIComponent(MAILBOX)}/messages?${qs}`,
  );
  return json?.data?.messages ?? [];
}

/** One message in full, including bodies and attachment metadata. */
async function message(id) {
  const json = await api(
    `/api/mailboxes/${encodeURIComponent(MAILBOX)}/messages/${encodeURIComponent(id)}`,
  );
  return json?.data ?? null;
}

module.exports = {
  enabled,
  mailboxAddress,
  taggedAddress,
  newTag,
  codeFromOllastack,
  messagesForTag,
  message,
};
