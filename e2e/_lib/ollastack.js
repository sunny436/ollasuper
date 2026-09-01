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
      // NEVER trust codes[0].
      //
      // The provider ranks its candidates "best match first", and that ranking
      // is a heuristic: an 8-digit code has been observed extracted as
      // ["1192","11923532"] — a 4-digit PREFIX ahead of the real code. Taking
      // the first entry then fails an 8-digit assertion with a value that is
      // not a code at all. A prefix is never the right answer when a longer
      // candidate exists, so pick the longest digit run.
      let codes = (Array.isArray(m.codes) ? m.codes : [])
        .filter((c) => /^\d+$/.test(String(c)))
        .sort((a, b) => String(b).length - String(a).length);
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

/**
 * Every message this run received, for assertions about content.
 *
 * `spam: true` switches to the SPAM view. That view is not a curiosity — an
 * agent mailbox excludes hard spam from the normal list, /wait and webhooks
 * entirely, so a filtered message is invisible to every other call here and
 * reads exactly like "never sent". Telling those two apart is the difference
 * between "the transport is broken" and "the content got filtered", which are
 * opposite problems with opposite fixes.
 */
async function messagesForTag(tag, opts = {}) {
  const qs = new URLSearchParams({ direction: "inbound", limit: "50", tag });
  if (opts.spam) qs.set("spam", "true");
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

/** The +tag out of an address, or null when there isn't one. */
function tagOf(address) {
  const m = /\+([^@]+)@/.exec(String(address));
  return m ? m[1] : null;
}

/**
 * An isolated real address for a run, from a caller-chosen prefix.
 *
 * Every script that used to sign up at `<something><ts>@gmail.com` and read the
 * code out of Mailpit can call this instead and get a mailbox that genuinely
 * receives. Non-alphanumerics are stripped because the tag has to survive both
 * the app's email normalisation and the provider's subaddress parsing.
 */
async function addressFor(prefix) {
  const tag = String(prefix).replace(/[^a-z0-9]/gi, "").toLowerCase();
  return taggedAddress(await mailboxAddress(), tag);
}

/** The newest code sent to a +tag address minted by addressFor. */
async function codeForAddress(address, subjectContains, timeoutMs = 90000) {
  const tag = tagOf(address);
  if (!tag) return null;
  return await codeFromOllastack(tag, subjectContains, timeoutMs);
}

module.exports = {
  enabled,
  mailboxAddress,
  taggedAddress,
  tagOf,
  addressFor,
  codeForAddress,
  newTag,
  codeFromOllastack,
  messagesForTag,
  message,
};
