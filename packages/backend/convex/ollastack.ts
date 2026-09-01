/**
 * Shared Ollastack Agent Mail configuration and read-only calls.
 *
 * Deliberately NOT a `"use node"` module. `scheduled/delivery.ts` runs in the
 * default Convex runtime and must import this for reconciliation; `email.ts`
 * IS `"use node"` (it needs nodemailer for the replica's SMTP path) and can
 * import this freely. The reverse would not be legal, which is why the config
 * lives here rather than in email.ts.
 */

/** Ollastack's public API root. Overridable for a staging tenant. */
export const OLLASTACK_BASE_DEFAULT = "https://login.ollastack.com";
export const OLLASTACK_TIMEOUT_MS = 30_000;

export type OllastackConfig = { base: string; token: string };

/** Null when the transport is not configured — callers fail closed on that. */
export function ollastackConfig(): OllastackConfig | null {
  const token = process.env.OLLASTACK_MAIL_TOKEN;
  if (!token) return null;
  const base = (
    process.env.OLLASTACK_MAIL_BASE_URL ?? OLLASTACK_BASE_DEFAULT
  ).replace(/\/$/, "");
  return { base, token };
}

/**
 * One outbound message as Ollastack reports it.
 *
 * `deliveryStatus` is the only field that says whether anything actually left:
 * `sent` (handed to the upstream provider) and `sending` (claimed by their
 * drain) mean custody changed hands; `failed` and `dry_run` mean it did not.
 * There is deliberately no `delivered` and no `bounced` — the provider does not
 * report either, so neither can ever be claimed by this system.
 */
export type OutboundMessage = {
  id: string;
  subject: string | null;
  toAddresses: string[];
  deliveryStatus: string | null;
  receivedAt: string | null;
};

function asOutbound(m: unknown): OutboundMessage | null {
  if (!m || typeof m !== "object") return null;
  const r = m as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  return {
    id: r.id,
    subject: typeof r.subject === "string" ? r.subject : null,
    toAddresses: Array.isArray(r.toAddresses)
      ? r.toAddresses.filter((x): x is string => typeof x === "string")
      : [],
    deliveryStatus:
      typeof r.deliveryStatus === "string" ? r.deliveryStatus : null,
    receivedAt: typeof r.receivedAt === "string" ? r.receivedAt : null,
  };
}

/**
 * GET one path, returning parsed JSON or null on ANY failure.
 *
 * Reconciliation is a best-effort upgrade to accuracy: a provider blip must
 * leave rows exactly as they were, never move them. So there is no throw path
 * and no partial result — null means "we learned nothing", which every caller
 * treats as "change nothing".
 */
async function getJson(
  cfg: OllastackConfig,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${cfg.base}${path}`, {
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(OLLASTACK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Fetch one outbound message by its provider id. Exact, no ambiguity. */
export async function fetchMessageById(
  cfg: OllastackConfig,
  mailboxId: string,
  messageId: string,
): Promise<OutboundMessage | null> {
  const json = await getJson(
    cfg,
    `/api/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}`,
  );
  const data = json?.data;
  return asOutbound(data);
}

/**
 * Search the mailbox's own outbound log for a message we may or may not have
 * sent.
 *
 * `q` matches subject / from / recipient (NOT the body), and `received_after`
 * pins the window to the instant we claimed the delivery — so the result set is
 * tiny and a match is effectively exact. The caller still refuses to resolve on
 * more than one hit rather than guessing.
 */
export async function findOutbound(
  cfg: OllastackConfig,
  mailboxId: string,
  opts: { recipient: string; subject: string; since: Date },
): Promise<OutboundMessage[] | null> {
  const qs = new URLSearchParams({
    direction: "outbound",
    q: opts.recipient,
    received_after: opts.since.toISOString(),
    limit: "100",
  });
  const json = await getJson(
    cfg,
    `/api/mailboxes/${encodeURIComponent(mailboxId)}/messages?${qs.toString()}`,
  );
  if (!json) return null;
  const data = json.data as { messages?: unknown } | undefined;
  const list = Array.isArray(data?.messages) ? data.messages : [];
  return list
    .map(asOutbound)
    .filter((m): m is OutboundMessage => m !== null)
    .filter(
      (m) =>
        m.subject === opts.subject &&
        m.toAddresses.some(
          (t) => t.toLowerCase() === opts.recipient.toLowerCase(),
        ),
    );
}

/** Did the provider actually take custody? The one place this is decided. */
export function isCustodyTaken(deliveryStatus: string | null): boolean {
  return deliveryStatus === "sent" || deliveryStatus === "sending";
}
