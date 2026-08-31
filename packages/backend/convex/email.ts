"use node";

import { v } from "convex/values";
import nodemailer from "nodemailer";
import { internalAction } from "./_generated/server";

/**
 * SMTP sender (Node action). Auth providers dispatch here; if SMTP_HOST is unset it's a
 * no-op (providers still log the code, so dev/log-fallback keeps working).
 * Local inbox: point SMTP_HOST/SMTP_PORT at Mailpit (default :1025).
 */
export const sendEmail = internalAction({
  args: { to: v.string(), subject: v.string(), text: v.string() },
  handler: async (_ctx, { to, subject, text }) => {
    const host = process.env.SMTP_HOST;
    if (!host) return;
    const transport = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? "1025"),
      secure: false,
      ...(process.env.SMTP_USER
        ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } }
        : {}),
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? "auth@myos.local",
      to,
      subject,
      text,
    });
  },
});

/**
 * Scheduled-report email. ONE module, two transports — never a second email
 * abstraction, and never a silent fallback between them.
 *
 * FAIL-CLOSED, and this is the whole point of the explicit setting. Production's
 * SMTP_HOST points at Mailpit, a local catcher that swallows everything it is
 * given. If this picked its transport by asking "is RESEND_API_KEY set?", then
 * an unset, rotated or typo'd key would silently route every report into that
 * catcher on the VM while this function returned ok and the UI showed the run
 * as delivered. Choosing by presence-of-a-credential is exactly the bug that
 * made deploy/backup.sh archive the wrong deployment for weeks.
 *
 * So the transport is named outright:
 *   resend   — RESEND_API_KEY required; missing ⇒ a recorded failure, never SMTP
 *   smtp     — the local replica only; deploy refuses this on the production host
 *   disabled — nothing is sent, and the caller records `skipped`
 */
type ReportResult = {
  ok: boolean;
  providerMessageId?: string;
  errorCode?: string;
  /** HTTP status, when there was one — the caller classifies transient vs not. */
  status?: number;
};

const MAX_SUBJECT = 120;

/**
 * The task title is user-authored and lands in a mail header. Strip CR/LF and
 * control characters (header injection on the SMTP path, and cheap insurance on
 * the JSON one) and clamp the length.
 */
function safeSubject(title: string): string {
  const clean = title
    // \p{Cc} is the Unicode control-character category: no literal control
    // bytes in the source, which are invisible in a diff and easy to mangle.
    .replace(/\p{Cc}+/gu, " ")
    .trim();
  return (clean || "Scheduled task").slice(0, MAX_SUBJECT);
}

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
    attachmentStorageId: v.optional(v.id("_storage")),
    idempotencyKey: v.string(),
    noteTooLarge: v.optional(v.boolean()),
    notePdfFailed: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<ReportResult> => {
    const transport = process.env.SCHEDULED_EMAIL_TRANSPORT ?? "disabled";
    if (transport === "disabled") {
      return { ok: false, errorCode: "transport_disabled" };
    }

    const subject = safeSubject(
      a.outcome === "succeeded" ? a.title : `${a.title} — ${a.outcome}`,
    );
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

    let attachment: { filename: string; content: string } | undefined;
    if (a.attachmentStorageId) {
      const blob = await ctx.storage.get(a.attachmentStorageId);
      if (blob) {
        const buf = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const byte of buf) binary += String.fromCharCode(byte);
        attachment = { filename: "report.pdf", content: btoa(binary) };
      }
    }

    if (transport === "smtp") {
      // Replica/dev only. deploy/71 refuses this value on the production host,
      // because SMTP_HOST there is a local catcher.
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
    }

    // transport === "resend"
    const key = process.env.RESEND_API_KEY;
    // The fail-closed branch. NOT a fallback to SMTP: a missing key is an
    // operator error that must surface as a failed delivery, not as mail
    // quietly diverted somewhere nobody reads.
    if (!key) return { ok: false, errorCode: "resend_key_missing" };

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
          // Provider-side duplicate suppression, so a retry of a request they
          // already accepted is dropped on their side and not just on ours.
          "Idempotency-Key": a.idempotencyKey,
        },
        body: JSON.stringify({
          from: process.env.SCHEDULED_EMAIL_FROM ?? "reports@ollasuper.com",
          to: [a.to],
          subject,
          text,
          html,
          ...(attachment ? { attachments: [attachment] } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });

      // A repeat of the SAME key with a DIFFERENT payload. The provider is
      // telling us this occurrence's email already went out; resending would
      // duplicate it, so treat it as sent and move on.
      if (res.status === 409) {
        return { ok: true, errorCode: "idempotency_conflict" };
      }
      if (!res.ok) return { ok: false, status: res.status };

      const data = (await res.json().catch(() => ({}))) as { id?: string };
      return { ok: true, providerMessageId: data.id };
    } catch {
      // Unreachable / timed out. No status, so the caller treats it as transient.
      return { ok: false, errorCode: "provider_unreachable" };
    }
  },
});
