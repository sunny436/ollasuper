/**
 * How a delivery outcome reads to a user.
 *
 * The distinction this file exists to preserve: a mail provider returning 2xx
 * means it took CUSTODY of the message, not that it arrived. Only a provider
 * webhook can say what happened next, and that webhook is optional. So
 * `accepted` and `delivered` are different words here, and the UI never
 * upgrades one into the other on its own — claiming delivery we cannot observe
 * is exactly the kind of small lie that costs someone a missed report.
 *
 * ON THE CURRENT TRANSPORT THAT DISTINCTION IS PERMANENT. Ollastack publishes
 * no outbound delivery webhook and no bounce feed — its status vocabulary is
 * `sent | failed | dry_run | scheduled | sending`, with no `delivered` and no
 * `bounced`, and its `/failures` endpoint is the INBOUND lost-mail trail. So
 * `delivered`, `bounced` and `complained` are states this system can no longer
 * enter at all; they stay in the union because the rows and the webhook route
 * still exist. `accepted` is the strongest true claim available, and
 * reconciliation (scheduled/delivery.ts) can only ever move a row DOWN from it
 * to `failed` — never up.
 */

export type DeliveryStatus =
  | "pending"
  | "sending"
  | "accepted"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "skipped"
  | "indeterminate";

export type PdfStatus = "none" | "succeeded" | "failed";

export type Attachment =
  | "none"
  | "attached"
  | "skipped_too_large"
  | "skipped_pdf_failed";

export type DeliveryRow = {
  occurrenceKey: string;
  status: DeliveryStatus;
  pdfStatus: PdfStatus;
  attachment: Attachment;
  errorCode: string | null;
};

export type Tone = "neutral" | "good" | "warn" | "bad";

const LABELS: Record<DeliveryStatus, { label: string; tone: Tone }> = {
  pending: { label: "Email queued", tone: "neutral" },
  sending: { label: "Sending email", tone: "neutral" },
  // Not "Sent": we know it was accepted, and that is all we know.
  accepted: { label: "Email accepted by the mail provider", tone: "good" },
  delivered: { label: "Email delivered", tone: "good" },
  bounced: { label: "Email bounced", tone: "bad" },
  complained: { label: "Marked as spam", tone: "warn" },
  failed: { label: "Email failed", tone: "bad" },
  skipped: { label: "No email sent", tone: "neutral" },
  // The honest name for "we cannot tell". Better than guessing either way.
  indeterminate: { label: "Email status unknown", tone: "warn" },
};

/** Reasons a user can act on. Anything else stays generic rather than leaking
 *  an internal code into the UI. */
const REASONS: Record<string, string> = {
  no_verified_recipient:
    "Verify your email address in Settings to receive these reports.",
  delivery_disabled: "Email delivery is turned off for this deployment.",
  transport_disabled: "Email delivery is not configured for this deployment.",
  ollastack_not_configured:
    "Email is not configured — contact your administrator.",
  // The provider answered "accepted" and then discarded the message. An
  // operator has to fix it; there is nothing the user can do, and pretending it
  // was sent is exactly the failure this state exists to expose.
  provider_dry_run:
    "The mail provider discarded the message — contact your administrator.",
  smtp_refused_on_production:
    "Email is misconfigured on this deployment — contact your administrator.",
  provider_auth_failed:
    "The mail provider rejected our credentials — contact your administrator.",
  invalid_recipient:
    "The mail provider rejected the address, so email was turned off for this task.",
  hard_bounce:
    "The address bounced, so email was turned off for this task.",
  provider_rate_limited: "The mail provider was busy; it will be retried.",
  provider_5xx: "The mail provider was unavailable; it will be retried.",
  provider_unreachable: "The mail provider could not be reached; it will be retried.",
  attempts_exhausted: "Email failed after several attempts.",
  worker_lost_after_send:
    "The run was interrupted while sending, so we cannot confirm whether it arrived.",
  // Learned after the fact, by asking the provider what became of a message it
  // had already accepted. See scheduled/delivery.ts:reconcile.
  reconciled_failed: "The mail provider could not deliver this email.",
  provider_status_failed: "The mail provider could not deliver this email.",
  // Two indistinguishable messages matched, so we will not claim either one is
  // this report. Saying "unknown" is the honest answer; resending is not.
  reconcile_ambiguous:
    "We could not confirm whether this email was sent, so it was not re-sent.",
};

export function deliveryLabel(row: DeliveryRow): {
  label: string;
  tone: Tone;
  reason: string | null;
} {
  const base = LABELS[row.status] ?? { label: row.status, tone: "neutral" as Tone };
  return {
    label: base.label,
    tone: base.tone,
    reason: row.errorCode ? (REASONS[row.errorCode] ?? null) : null,
  };
}

/** The PDF's own outcome, which is independent of the email's. */
export function attachmentNote(row: DeliveryRow): string | null {
  if (row.attachment === "attached") return "PDF attached";
  if (row.attachment === "skipped_too_large") {
    // A successful render, just too big to attach — say that, rather than
    // implying the report failed.
    return "PDF was too large to attach — download it above";
  }
  if (row.attachment === "skipped_pdf_failed") return "PDF could not be generated";
  if (row.pdfStatus === "succeeded") return "PDF generated";
  return null;
}

export const TONE_CLASS: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  good: "text-brand-ink",
  warn: "text-amber-600 dark:text-amber-500",
  bad: "text-destructive",
};
