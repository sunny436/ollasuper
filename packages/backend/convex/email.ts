"use node";

import { v } from "convex/values";
import nodemailer from "nodemailer";
import { internalAction } from "./_generated/server";
import { reportSubject } from "./mailSubject";
import {
  isCustodyTaken,
  OLLASTACK_TIMEOUT_MS,
  ollastackConfig,
} from "./ollastack";

/**
 * MAIL TRANSPORTS. One module, three named transports, and never a silent
 * fallback between them.
 *
 *   ollastack — Ollastack Agent Mail (production). HTTP, token + mailbox id.
 *   smtp      — the local Mailpit catcher: dev and the replica ONLY.
 *   disabled  — nothing is sent, and the caller records `skipped`.
 *
 * The transport is NAMED, never inferred from "is a credential present?".
 * Choosing by presence-of-a-credential is exactly the bug that made
 * deploy/backup.sh archive the wrong deployment for weeks.
 */

type OllastackAttachment = {
  filename: string;
  /** Base64 file bytes. Provider cap is 10MB across all attachments. */
  content: string;
  contentType?: string;
};

type TransportResult = {
  ok: boolean;
  providerMessageId?: string;
  errorCode?: string;
  /** HTTP status, when there was one — the caller classifies transient vs not. */
  status?: number;
  /** Provider-supplied backoff hint, in seconds, on RATE_LIMIT_EXCEEDED. */
  retryAfter?: number;
};

/**
 * Is the local SMTP catcher an acceptable transport on THIS deployment?
 *
 * On the production VM `SMTP_HOST` points at Mailpit, a catcher that swallows
 * everything it is handed. deploy/71 has refused `smtp` on that host since it
 * was written — and production was running `smtp` anyway, with 32 captured
 * messages including a real user's verification code. A deploy-script guard is
 * evidently not enough, so the refusal lives in the code path that actually
 * sends.
 *
 * A loopback SITE_URL (or none at all) means a dev box or the replica, where
 * Mailpit is the entire point. ALLOW_SMTP_TRANSPORT=1 is the same explicit
 * escape hatch deploy/71 already uses.
 */
function smtpTransportAllowed(): boolean {
  if (process.env.ALLOW_SMTP_TRANSPORT === "1") return true;
  const site = process.env.SITE_URL ?? "";
  if (!site) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(site);
}

/**
 * Send one message from an Ollastack mailbox.
 *
 * A 2xx is NOT proof that anything was transmitted. The response carries the
 * stored outbound message, whose `deliveryStatus` may be `dry_run` — the
 * provider accepted it and swallowed it — or `failed`. Treating a bare 2xx as
 * success would reproduce the exact Mailpit defect this change exists to
 * remove, on a different provider. So the accepted states are named outright
 * and everything else is a failure.
 *
 * The token must never reach a returned or thrown message: authCodes.deliverCode
 * logs `e.message` on the auth path.
 */
async function ollastackSend(
  mailboxId: string | undefined,
  body: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    attachments?: OllastackAttachment[];
  },
): Promise<TransportResult> {
  const cfg = ollastackConfig();
  if (!cfg || !mailboxId) {
    // Fail-closed. A selected transport with missing configuration is an
    // operator error that must surface, never a fall back to SMTP.
    return { ok: false, errorCode: "ollastack_not_configured" };
  }

  try {
    const res = await fetch(
      `${cfg.base}/api/mailboxes/${encodeURIComponent(mailboxId)}/send`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.token}`,
        },
        // No Idempotency-Key: the provider has no such header. Duplicate
        // suppression is therefore OURS — see scheduled/delivery.ts, where a
        // crashed send is reconciled against the provider's own outbound log
        // instead of being blind-retried.
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OLLASTACK_TIMEOUT_MS),
      },
    );

    const json = (await res.json().catch(() => ({}))) as {
      data?: { id?: unknown; deliveryStatus?: unknown };
      error?: { code?: unknown; retryAfter?: unknown };
    };

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        errorCode:
          typeof json.error?.code === "string" ? json.error.code : undefined,
        retryAfter:
          typeof json.error?.retryAfter === "number"
            ? json.error.retryAfter
            : undefined,
      };
    }

    const deliveryStatus =
      typeof json.data?.deliveryStatus === "string"
        ? json.data.deliveryStatus
        : "";
    // `sent` = handed to the upstream provider; `sending` = claimed by their
    // drain. Both mean custody changed hands. `dry_run`, `failed` and
    // `scheduled` (which we never request) do not.
    if (!isCustodyTaken(deliveryStatus)) {
      return {
        ok: false,
        errorCode:
          deliveryStatus === "dry_run"
            ? "provider_dry_run"
            : `provider_status_${deliveryStatus || "unknown"}`,
      };
    }

    return {
      ok: true,
      providerMessageId:
        typeof json.data?.id === "string" ? json.data.id : undefined,
    };
  } catch {
    // Unreachable / timed out. No status, so the caller treats it as transient.
    return { ok: false, errorCode: "provider_unreachable" };
  }
}

/** Named transport for AUTH email. Unknown values fail closed. */
function authTransport(): "smtp" | "ollastack" | "disabled" {
  const named = process.env.AUTH_EMAIL_TRANSPORT ?? "smtp";
  if (named === "ollastack") return "ollastack";
  if (named === "disabled") return "disabled";
  if (named !== "smtp") return "disabled";
  if (!smtpTransportAllowed()) {
    // Loud, not silent: deliverCode catches and logs this. A silent return is
    // what let a dead transport hide in production in the first place.
    throw new Error(
      "auth email: smtp transport refused on this deployment (SMTP_HOST is a local catcher)",
    );
  }
  return "smtp";
}

/**
 * Auth code sender (OTP / email verification / password reset).
 *
 * Reached from authCodes.deliverCode via all three Email providers. Plain text
 * on purpose: a one-time code needs no markup, and text-only mail is less
 * likely to be filtered.
 */
export const sendEmail = internalAction({
  args: { to: v.string(), subject: v.string(), text: v.string() },
  handler: async (_ctx, { to, subject, text }) => {
    const transport = authTransport();
    if (transport === "disabled") return;

    if (transport === "ollastack") {
      const sent = await ollastackSend(process.env.OLLASTACK_AUTH_MAILBOX_ID, {
        to,
        subject,
        text,
      });
      if (!sent.ok) {
        // THROW rather than return. deliverCode logs it. The previous
        // SMTP-only implementation returned silently when unconfigured, which
        // is how a deployment that could not mail anyone still looked healthy.
        throw new Error(
          `auth email send failed: ${sent.errorCode ?? sent.status ?? "unknown"}`,
        );
      }
      return;
    }

    // transport === "smtp" — Mailpit on dev/replica. Local inbox: point
    // SMTP_HOST/SMTP_PORT at Mailpit (default :1025).
    const host = process.env.SMTP_HOST;
    if (!host) return;
    const nodemailerTransport = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? "1025"),
      secure: false,
      ...(process.env.SMTP_USER
        ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } }
        : {}),
    });
    await nodemailerTransport.sendMail({
      from: process.env.SMTP_FROM ?? "auth@myos.local",
      to,
      subject,
      text,
    });
  },
});

/**
 * Scheduled-report email.
 *
 * FAIL-CLOSED, and this is the whole point of the explicit setting. Production's
 * SMTP_HOST points at Mailpit, a local catcher that swallows everything it is
 * given. If this picked its transport by asking "is a credential set?", then an
 * unset, rotated or typo'd credential would silently route every report into
 * that catcher on the VM while this function returned ok and the UI showed the
 * run as delivered.
 *
 * So the transport is named outright:
 *   ollastack — Ollastack Agent Mail; missing config ⇒ a recorded failure
 *   smtp      — the local replica only; refused on a production deployment
 *   disabled  — nothing is sent, and the caller records `skipped`
 */
type ReportResult = {
  ok: boolean;
  providerMessageId?: string;
  errorCode?: string;
  /** HTTP status, when there was one — the caller classifies transient vs not. */
  status?: number;
  /** Provider-supplied backoff hint, in seconds, on RATE_LIMIT_EXCEEDED. */
  retryAfter?: number;
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * Model-authored markdown becomes email HTML through an ESCAPE-FIRST allowlist:
 * every character is escaped, then a small set of block shapes is recognised in
 * the escaped text. Nothing the model writes can therefore emit a tag — which is
 * the same reason the chat renderer does not install rehype-raw.
 */
function toHtml(markdown: string): string {
  const out: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (list?.length) out.push(`<ul>${list.join("")}</ul>`);
    list = null;
  };
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]?.length ?? 1;
      out.push(`<h${level}>${esc(heading[2] ?? "")}</h${level}>`);
    } else if (bullet) {
      list ??= [];
      list.push(`<li>${esc(bullet[1] ?? "")}</li>`);
    } else if (!line.trim()) {
      flush();
    } else {
      flush();
      out.push(`<p>${esc(line)}</p>`);
    }
  }
  flush();
  return out.join("\n");
}

export const sendReportEmail = internalAction({
  args: {
    to: v.string(),
    title: v.string(),
    outcome: v.string(),
    markdown: v.string(),
    // The attachment arrives as base64 rather than as a storage id to read
    // back: reading it back failed in production with a transient storage
    // error, and the caller already had the bytes.
    attachmentBase64: v.optional(v.string()),
    idempotencyKey: v.string(),
    noteTooLarge: v.optional(v.boolean()),
    notePdfFailed: v.optional(v.boolean()),
  },
  handler: async (_ctx, a): Promise<ReportResult> => {
    const transport = process.env.SCHEDULED_EMAIL_TRANSPORT ?? "disabled";
    if (transport === "disabled") {
      return { ok: false, errorCode: "transport_disabled" };
    }
    // FAIL CLOSED on anything we do not recognise. Without this, a stale value
    // — `resend`, say, left over from a provider that no longer has a branch —
    // would fall past every check and land in the SMTP path, i.e. Mailpit.
    // That is precisely the silent-swallow this module exists to prevent, so an
    // unknown transport must never be a synonym for "the local catcher".
    if (transport !== "ollastack" && transport !== "smtp") {
      return { ok: false, errorCode: "transport_unknown" };
    }
    if (transport === "smtp" && !smtpTransportAllowed()) {
      // A recorded failure, NOT a throw: `deliver` is total and every exit must
      // go through `record`. The UI then says email is misconfigured rather
      // than claiming a report was sent into a local catcher.
      return { ok: false, errorCode: "smtp_refused_on_production" };
    }

    // Shared with scheduled/delivery.ts:reconcile, which must rebuild this
    // byte-for-byte to find a crashed send in the provider's outbound log.
    const subject = reportSubject(a.title, a.outcome);
    const notes: string[] = [];
    if (a.noteTooLarge) {
      notes.push(
        "The PDF report was too large to attach; open it in OllaSuper to download it.",
      );
    }
    if (a.notePdfFailed) {
      notes.push(
        "The PDF report could not be generated; the result is available in OllaSuper.",
      );
    }
    // A run can succeed and still produce nothing (a stopped stream, an empty
    // answer). Sending a blank email in that case is worse than saying so.
    const body =
      a.outcome === "succeeded" && a.markdown.trim()
        ? a.markdown
        : a.outcome === "succeeded"
          ? "This scheduled run finished without producing any text. Open OllaSuper to see the run."
          : `This scheduled run ${a.outcome}. Open OllaSuper to see the details.`;
    const text = [body, ...notes].join("\n\n");
    const html = [toHtml(body), ...notes.map((n) => `<p><em>${esc(n)}</em></p>`)].join("\n");

    const attachment = a.attachmentBase64
      ? { filename: "report.pdf", content: a.attachmentBase64 }
      : undefined;

    if (transport === "ollastack") {
      return await ollastackSend(process.env.OLLASTACK_REPORTS_MAILBOX_ID, {
        to: a.to,
        subject,
        text,
        html,
        // Provider cap is 10MB across all attachments; delivery.ts already
        // drops anything over 5MB before it reaches here.
        ...(attachment
          ? {
              attachments: [
                {
                  filename: attachment.filename,
                  content: attachment.content,
                  contentType: "application/pdf",
                },
              ],
            }
          : {}),
      });
    }

    // transport === "smtp" — replica/dev only, and only past the guard above.
    const host = process.env.SMTP_HOST;
    if (!host) return { ok: false, errorCode: "smtp_not_configured" };
    const nodemailerTransport = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? "1025"),
      secure: false,
      ...(process.env.SMTP_USER
        ? {
            auth: {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS ?? "",
            },
          }
        : {}),
    });
    const info = await nodemailerTransport.sendMail({
      from: process.env.SMTP_FROM ?? "reports@myos.local",
      to: a.to,
      subject,
      text,
      html,
      ...(attachment
        ? {
            attachments: [
              {
                filename: attachment.filename,
                content: attachment.content,
                encoding: "base64",
              },
            ],
          }
        : {}),
    });
    return { ok: true, providerMessageId: String(info.messageId ?? "") };
  },
});
