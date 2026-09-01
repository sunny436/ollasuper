import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { reportSubject } from "../mailSubject";
import { notify } from "../notifications";
import {
  fetchMessageById,
  findOutbound,
  isCustodyTaken,
  ollastackConfig,
} from "../ollastack";

/**
 * Phase 4 delivery: PDF report + email, as a state machine SEPARATE from
 * execution.
 *
 * WHY SEPARATE. A scheduled run that produced an answer has succeeded. Whether
 * an email about it left the building is a different question, with different
 * failure modes, a different retry budget and an external dependency that can
 * be down for hours. Folding delivery into the occurrence would mean a bounced
 * address could put a run back on the queue and re-bill a model turn. So:
 * `finalize` commits the terminal transition and schedules delivery, and then
 * the occurrence is finished forever, whatever happens here.
 *
 * WHY A TOTAL ACTION PLUS A REAPER. A Convex action that throws is NOT retried
 * — the same reason chat/stream.ts:dispatch wraps its whole body in try/catch
 * and writes the failure through failStream. `deliver` follows that shape
 * exactly: it can only exit by recording a definite status, and `reap` (a cron)
 * is the retry mechanism, not an optional tidy-up.
 */

/** Delivery attempts. Independent of the occurrence's own MAX_ATTEMPTS. */
export const MAX_DELIVERY_ATTEMPTS = 3;
/** A `sending` row older than this is presumed abandoned by the reaper. */
export const DELIVERY_LEASE_MS = 120_000;
/**
 * Beyond this, a crashed-mid-send delivery is NOT retried. Inside it, a retry
 * carries the same Idempotency-Key and the provider suppresses the duplicate;
 * outside it, that guarantee has expired and we prefer a possibly-lost email to
 * a possible duplicate. Conservative on purpose — see `reap`.
 *
 * Applies ONLY to a provider that honours the key. See `providerIsIdempotent`.
 */
export const IDEMPOTENCY_WINDOW_MS = 20 * 60 * 1000;

/**
 * Does the configured provider suppress a duplicate send on its own?
 *
 * Resend did, via `Idempotency-Key`. Ollastack has no such header — verified
 * against its OpenAPI spec, which accepts no headers beyond auth and no
 * metadata field. So on that transport a retry of a send it already accepted
 * would deliver the report TWICE.
 *
 * A crashed `sending` row is therefore never re-queued blind there. It goes
 * straight to `indeterminate`, and `reconcile` resolves it by ASKING the
 * provider whether the message exists — which is strictly better than either
 * guessing or giving up.
 */
function providerIsIdempotent(): boolean {
  return (process.env.SCHEDULED_EMAIL_TRANSPORT ?? "disabled") !== "ollastack";
}

/** Concurrent in-flight sends, to stay under the provider's rate limit. */
export const MAX_INFLIGHT_EMAIL = 2;
/** How long a deferred delivery waits before trying to claim again. */
export const DEFER_RETRY_MS = 5_000;
const RETRY_BASE_MS = 30_000;
/** Bound on one reaper pass. */
const REAP_SCAN = 50;

function backoffMs(attempts: number): number {
  return RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

type Outcome = "succeeded" | "failed" | "cancelled";

async function loadByOccurrence(
  ctx: QueryCtx,
  occurrenceKey: string,
): Promise<Doc<"scheduledDeliveries"> | null> {
  return await ctx.db
    .query("scheduledDeliveries")
    .withIndex("by_occurrence_channel", (q) =>
      q.eq("occurrenceKey", occurrenceKey).eq("channel", "email"),
    )
    .unique();
}

/**
 * Decide, snapshot and enqueue — inside the caller's transaction.
 *
 * Called from `onOccurrenceTerminal`, i.e. from BOTH `finalize` and
 * `reapStalled`, and from nowhere else. In particular it is NOT called from the
 * claim-time or task-deletion cancellations: those occurrences never ran, so
 * there is no result to report and no run the user did not already cause.
 *
 * Everything the send will need is snapshotted here rather than re-read later.
 * Preferences, recipient and outcome are settled at this instant, so a pref
 * toggle, a task edit, a deletion or an email change between now and the send
 * cannot retarget work that was already decided.
 */
export async function enqueueDelivery(
  ctx: MutationCtx,
  occ: Doc<"scheduledTaskOccurrences">,
  outcome: Outcome,
): Promise<void> {
  const task = await ctx.db.get(occ.taskId);
  if (!task) return;

  // Absent means DISABLED — the inverse of the in-app pair. Deploying Phase 4
  // must not make a single existing task email anyone.
  const wantEmail =
    outcome === "succeeded"
      ? task.emailOnSuccess === true
      : task.emailOnFailure === true;
  if (!wantEmail) return;

  // The recipient is the OWNER's address, read server-side, and only if it is
  // verified. Never from args, never from task content, never a list.
  const user = await ctx.db.get(occ.userId);
  const verified = Boolean(user?.email && user?.emailVerificationTime);
  const recipient = verified ? (user?.email ?? undefined) : undefined;

  // A failed or cancelled run has no result to render, so a PDF is meaningless
  // however the task is configured.
  const wantPdf = task.attachPdf === true && outcome === "succeeded";

  // Read-then-insert through by_occurrence_channel, in ONE mutation. Convex has
  // no unique constraints; this read joins the transaction's read set, so a
  // concurrent insert conflicts and re-runs rather than duplicating.
  const existing = await loadByOccurrence(ctx, occ.occurrenceKey);
  if (existing) return;

  const now = Date.now();
  const id = await ctx.db.insert("scheduledDeliveries", {
    occurrenceKey: occ.occurrenceKey,
    taskId: occ.taskId,
    userId: occ.userId,
    workspaceId: occ.workspaceId,
    channel: "email",
    // No verified address is a SKIP, not a failure: there is nothing to retry
    // and nothing the scheduler did wrong.
    status: recipient ? "pending" : "skipped",
    pdfStatus: "none",
    attachment: "none",
    wantEmail: true,
    wantPdf,
    recipient,
    outcome,
    idempotencyKey: `${occ.occurrenceKey}:email`,
    errorCode: recipient ? undefined : "no_verified_recipient",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
  if (!recipient) return;

  // Transactional: enqueued if and only if this mutation commits.
  //
  // No jitter here. A burst is handled by `claim`'s in-flight cap, which DEFERS
  // and re-schedules explicitly — a real queue rather than a random spread that
  // would only make the collision less likely, and that would put
  // non-determinism inside a mutation.
  await ctx.scheduler.runAfter(0, internal.scheduled.delivery.deliver, {
    deliveryId: id,
  });
}

/** pending → sending. The serialisable mutex that makes a send happen once. */
export const claim = internalMutation({
  args: { deliveryId: v.id("scheduledDeliveries") },
  handler: async (
    ctx,
    { deliveryId },
  ): Promise<{ ok: boolean; reason?: string }> => {
    const row = await ctx.db.get(deliveryId);
    if (!row) return { ok: false, reason: "unknown" };
    if (row.status !== "pending") return { ok: false, reason: row.status };
    if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await ctx.db.patch(deliveryId, {
        status: "failed",
        errorCode: row.errorCode ?? "attempts_exhausted",
        updatedAt: Date.now(),
      });
      return { ok: false, reason: "attempts_exhausted" };
    }

    // Provider rate limits are per-account, so the cap has to be global rather
    // than per-user. Over the cap we DEFER — the row stays `pending` and the
    // reaper picks it up. Deferral is never a drop.
    const inflight = await ctx.db
      .query("scheduledDeliveries")
      .withIndex("by_status_claimed", (q) => q.eq("status", "sending"))
      .take(MAX_INFLIGHT_EMAIL + 1);
    if (inflight.length >= MAX_INFLIGHT_EMAIL) {
      return { ok: false, reason: "deferred" };
    }

    await ctx.db.patch(deliveryId, {
      status: "sending",
      attempts: row.attempts + 1,
      claimedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { ok: true };
  },
});

/** The only way out of `sending`. Always called, including on every error. */
export const record = internalMutation({
  args: {
    deliveryId: v.id("scheduledDeliveries"),
    status: v.union(
      v.literal("accepted"),
      v.literal("failed"),
      v.literal("skipped"),
      v.literal("pending"),
      v.literal("indeterminate"),
    ),
    errorCode: v.optional(v.string()),
    providerMessageId: v.optional(v.string()),
    pdfStatus: v.optional(
      v.union(v.literal("none"), v.literal("succeeded"), v.literal("failed")),
    ),
    attachment: v.optional(
      v.union(
        v.literal("none"),
        v.literal("attached"),
        v.literal("skipped_too_large"),
        v.literal("skipped_pdf_failed"),
      ),
    ),
    retryInMs: v.optional(v.number()),
  },
  handler: async (ctx, a): Promise<{ ok: boolean }> => {
    const row = await ctx.db.get(a.deliveryId);
    if (!row) return { ok: false };
    const now = Date.now();
    await ctx.db.patch(a.deliveryId, {
      status: a.status,
      errorCode: a.errorCode,
      providerMessageId: a.providerMessageId ?? row.providerMessageId,
      pdfStatus: a.pdfStatus ?? row.pdfStatus,
      attachment: a.attachment ?? row.attachment,
      claimedAt: a.status === "pending" ? undefined : row.claimedAt,
      updatedAt: now,
    });
    if (a.status === "pending" && a.retryInMs !== undefined) {
      await ctx.scheduler.runAfter(
        a.retryInMs,
        internal.scheduled.delivery.deliver,
        { deliveryId: a.deliveryId },
      );
    }
    return { ok: true };
  },
});

/**
 * Rescue rows nothing else will.
 *
 * Two distinct hazards, deliberately handled differently:
 *  - `pending` rows whose scheduled action never ran (it threw, and Convex does
 *    not retry a thrown action). Safe to re-enqueue: nothing was sent.
 *  - `sending` rows whose action died. Something MAY have been sent. Inside the
 *    provider's idempotency window a retry is suppressed on their side, so we
 *    retry; beyond it, we record `indeterminate` and stop. Never resend blind.
 */
export const reap = internalMutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ requeued: number; indeterminate: number }> => {
    const now = Date.now();
    let requeued = 0;
    let indeterminate = 0;

    const stuck = await ctx.db
      .query("scheduledDeliveries")
      .withIndex("by_status_claimed", (q) =>
        q.eq("status", "sending").lt("claimedAt", now - DELIVERY_LEASE_MS),
      )
      .take(REAP_SCAN);
    for (const row of stuck) {
      const withinWindow =
        providerIsIdempotent() &&
        row.claimedAt !== undefined &&
        now - row.claimedAt < IDEMPOTENCY_WINDOW_MS;
      if (withinWindow && row.attempts < MAX_DELIVERY_ATTEMPTS) {
        await ctx.db.patch(row._id, {
          status: "pending",
          claimedAt: undefined,
          updatedAt: now,
        });
        await ctx.scheduler.runAfter(
          backoffMs(row.attempts),
          internal.scheduled.delivery.deliver,
          { deliveryId: row._id },
        );
        requeued++;
        continue;
      }
      await ctx.db.patch(row._id, {
        status: "indeterminate",
        errorCode: "worker_lost_after_send",
        claimedAt: undefined,
        updatedAt: now,
      });
      indeterminate++;
    }

    // `pending` rows that were never picked up. claimedAt is unset on these, so
    // fall back to createdAt for the age test.
    const orphaned = await ctx.db
      .query("scheduledDeliveries")
      .withIndex("by_status_claimed", (q) => q.eq("status", "pending"))
      .take(REAP_SCAN);
    for (const row of orphaned) {
      if (now - row.updatedAt < DELIVERY_LEASE_MS) continue;
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        await ctx.db.patch(row._id, {
          status: "failed",
          errorCode: row.errorCode ?? "attempts_exhausted",
          updatedAt: now,
        });
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.scheduled.delivery.deliver, {
        deliveryId: row._id,
      });
      await ctx.db.patch(row._id, { updatedAt: now });
      requeued++;
    }

    return { requeued, indeterminate };
  },
});

/**
 * Hard ceiling on an email attachment. A PDF above this is still STORED and
 * downloadable in-app; only the attachment is dropped.
 *
 * 5MB rather than 8: the bytes now travel to the mail action as base64, which
 * inflates by ~4/3, so this keeps the argument well inside Convex's function
 * payload limit with room to spare. Real reports are tens of kilobytes.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Bound on what is handed to the renderer. Truncation is marked in the PDF. */
export const MAX_MARKDOWN_CHARS = 400_000;

/**
 * Everything the send needs, assembled server-side.
 *
 * Convex owns the result, so Convex assembles the report payload — the renderer
 * is handed content and never reads anything. Deliberately contains no lease
 * token, workflow id or storage id: what is not in this object cannot reach a
 * PDF or an email.
 */
export const payload = internalQuery({
  args: { deliveryId: v.id("scheduledDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    const row = await ctx.db.get(deliveryId);
    if (!row || !row.recipient) return null;
    const task = await ctx.db.get(row.taskId);
    if (!task) return null;

    const occ = await ctx.db
      .query("scheduledTaskOccurrences")
      .withIndex("by_occurrence_key", (q) =>
        q.eq("occurrenceKey", row.occurrenceKey),
      )
      .unique();
    if (!occ) return null;

    const revision = await ctx.db.get(occ.revisionId);
    const message = occ.messageId ? await ctx.db.get(occ.messageId) : null;
    const body = (message?.content ?? "").slice(0, MAX_MARKDOWN_CHARS);

    return {
      recipient: row.recipient,
      idempotencyKey: row.idempotencyKey,
      outcome: row.outcome,
      // A PDF of nothing is worse than no PDF: keep the email, drop the render.
      wantPdf: row.wantPdf && body.trim().length > 0,
      truncated: (message?.content ?? "").length > MAX_MARKDOWN_CHARS,
      title: task.title,
      // The PINNED revision's prompt — what this run actually executed, never
      // the task's current text.
      prompt: revision?.prompt ?? "",
      timezone: task.spec.timezone,
      scheduledFor: occ.scheduledFor,
      startedAt: occ.startedAt ?? null,
      finishedAt: occ.finishedAt ?? null,
      attempts: occ.attempts,
      errorCode: occ.errorCode ?? null,
      markdown: body,
      streamId: occ.streamId ?? null,
      taskId: row.taskId,
    };
  },
});

/**
 * Register an already-stored PDF blob as an artifact of the occurrence's own
 * turn — mirroring chat/artifacts.ts:registerArtifact, including its
 * store-then-dedupe shape.
 *
 * Ownership is derived from the OCCURRENCE, never from arguments. That is what
 * lets the renderer be a pure function with no Convex access at all: it returns
 * bytes, and every ownership decision stays here.
 */
export const registerReportArtifact = internalMutation({
  args: {
    deliveryId: v.id("scheduledDeliveries"),
    storageId: v.id("_storage"),
    filename: v.string(),
    size: v.number(),
  },
  handler: async (
    ctx,
    a,
  ): Promise<{ artifactId: Id<"chatArtifacts"> | null }> => {
    const row = await ctx.db.get(a.deliveryId);
    if (!row) {
      await ctx.storage.delete(a.storageId).catch(() => {});
      return { artifactId: null };
    }
    const occ = await ctx.db
      .query("scheduledTaskOccurrences")
      .withIndex("by_occurrence_key", (q) =>
        q.eq("occurrenceKey", row.occurrenceKey),
      )
      .unique();
    if (!occ?.streamId || !occ.messageId || !occ.threadId) {
      await ctx.storage.delete(a.storageId).catch(() => {});
      return { artifactId: null };
    }

    const artifactKey = `${row.occurrenceKey}:report-pdf`;
    const existing = await ctx.db
      .query("chatArtifacts")
      .withIndex("by_stream_key", (q) =>
        q.eq("streamId", occ.streamId as string).eq("artifactKey", artifactKey),
      )
      .first();
    if (existing) {
      // A retry re-rendered the report. Drop the duplicate blob and reuse the
      // row, so a delivery retry can never leave an orphan or a second card.
      await ctx.storage.delete(a.storageId).catch(() => {});
      await ctx.db.patch(a.deliveryId, {
        pdfArtifactId: existing._id,
        updatedAt: Date.now(),
      });
      return { artifactId: existing._id };
    }

    const artifactId = await ctx.db.insert("chatArtifacts", {
      streamId: occ.streamId,
      messageId: occ.messageId,
      threadId: occ.threadId,
      workspaceId: occ.workspaceId,
      userId: occ.userId,
      storageId: a.storageId,
      filename: a.filename,
      format: "pdf",
      mime: "application/pdf",
      size: a.size,
      artifactKey,
      createdAt: Date.now(),
    });
    await ctx.db.patch(a.deliveryId, {
      pdfArtifactId: artifactId,
      updatedAt: Date.now(),
    });
    return { artifactId };
  },
});

/**
 * Transient vs permanent, decided once and in one place.
 *
 * A transient failure is retried with the SAME idempotency key; a permanent one
 * stops immediately, because retrying an invalid address or a bad credential
 * three times only burns sender reputation and hides the real fault.
 */
/**
 * Failures that arrive WITHOUT an HTTP status and that retrying cannot fix.
 *
 * `provider_dry_run` is the important one: the provider returned 200 and told
 * us it discarded the message. That is a deployment fault, not a blip, and
 * three more attempts would only bury it.
 */
const PERMANENT_NO_STATUS_CODES = new Set([
  "ollastack_not_configured",
  "provider_dry_run",
  "smtp_refused_on_production",
  "smtp_not_configured",
]);

function classify(status: number): { transient: boolean; code: string } {
  if (status === 429) return { transient: true, code: "provider_rate_limited" };
  if (status >= 500) return { transient: true, code: "provider_5xx" };
  if (status === 401 || status === 403) {
    return { transient: false, code: "provider_auth_failed" };
  }
  if (status === 422) return { transient: false, code: "invalid_recipient" };
  return { transient: false, code: `provider_${status}` };
}

/**
 * Render the report to PDF via myos-ai.
 *
 * The endpoint is a PURE FUNCTION: payload in, bytes out. It holds no stream
 * id, no ingress secret and no Convex access, so it cannot write anything
 * anywhere — ownership never leaves this file. Returns null on any failure;
 * a PDF is an enhancement to the email, never a precondition for it.
 */
async function renderPdf(
  base: string,
  key: string,
  body: unknown,
  correlationId: string,
): Promise<ArrayBuffer | null> {
  const res = await fetch(`${base.replace(/\/$/, "")}/v1/report/pdf`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-service-key": key,
      "x-correlation-id": correlationId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return null;
  return await res.arrayBuffer();
}

type PdfState = {
  pdfStatus: "none" | "succeeded" | "failed";
  attachment: "none" | "attached" | "skipped_too_large" | "skipped_pdf_failed";
  /**
   * The attachment itself, base64, or null.
   *
   * NOT a storage id. This used to hand the mail action an Id<"_storage"> to
   * read back, and production failed three times over with
   * `Transient error while running storage get url` — on a 44KB PDF, so not a
   * size problem. The bytes are already in memory here, so reading them back
   * out of storage bought nothing and added a failure mode between two actions.
   * The artifact is still stored separately for in-app download.
   */
  attachmentBase64: string | null;
};

/** Chunked so a multi-megabyte attachment cannot blow the argument stack. */
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * One delivery attempt, end to end.
 *
 * TOTAL by construction: every exit path goes through `record`, so a row can
 * never be left in `sending` by this function's own logic. (A worker that dies
 * mid-flight still can — that is what `reap` is for.)
 */
export const deliver = internalAction({
  args: { deliveryId: v.id("scheduledDeliveries") },
  handler: async (ctx: ActionCtx, { deliveryId }): Promise<void> => {
    // Off by default, and flipped last in the deployment order: execution is
    // proven in production before a single email can leave.
    if (process.env.SCHEDULED_DELIVERY_ENABLED !== "true") {
      await ctx.runMutation(internal.scheduled.delivery.record, {
        deliveryId,
        status: "skipped",
        errorCode: "delivery_disabled",
      });
      return;
    }

    const claimed = await ctx.runMutation(internal.scheduled.delivery.claim, {
      deliveryId,
    });
    // Not ours: already sent, already failed, or deferred under the in-flight
    // cap. A deferral re-queues ITSELF rather than waiting on the reaper — the
    // row is healthy and merely waiting its turn, so making it look abandoned
    // for two minutes would be both slower and a lie.
    if (!claimed.ok) {
      if (claimed.reason === "deferred") {
        await ctx.scheduler.runAfter(
          DEFER_RETRY_MS,
          internal.scheduled.delivery.deliver,
          { deliveryId },
        );
      }
      return;
    }

    let pdf: PdfState = {
      pdfStatus: "none",
      attachment: "none",
      attachmentBase64: null,
    };
    try {
      const p = await ctx.runQuery(internal.scheduled.delivery.payload, {
        deliveryId,
      });
      if (!p) {
        await ctx.runMutation(internal.scheduled.delivery.record, {
          deliveryId,
          status: "skipped",
          errorCode: "payload_unavailable",
        });
        return;
      }

      const base = process.env.AI_BASE_URL;
      const serviceKey = process.env.AI_SERVICE_KEY;

      if (p.wantPdf) {
        pdf = await buildPdf(ctx, deliveryId, p, base, serviceKey);
      }

      const sent = await ctx.runAction(internal.email.sendReportEmail, {
        to: p.recipient,
        // Sanitised in email.ts: the title is user-authored and becomes a header.
        title: p.title,
        outcome: p.outcome,
        markdown: p.markdown,
        attachmentBase64: pdf.attachmentBase64 ?? undefined,
        idempotencyKey: p.idempotencyKey,
        noteTooLarge: pdf.attachment === "skipped_too_large",
        notePdfFailed: pdf.attachment === "skipped_pdf_failed",
      });

      if (sent.ok) {
        // `accepted`, never `delivered`: a 2xx says the provider took custody
        // and nothing more. Only a webhook knows what happened next.
        await ctx.runMutation(internal.scheduled.delivery.record, {
          deliveryId,
          status: "accepted",
          providerMessageId: sent.providerMessageId,
          pdfStatus: pdf.pdfStatus,
          attachment: pdf.attachment,
        });
        return;
      }

      const cls =
        sent.status !== undefined
          ? classify(sent.status)
          : {
              // A failure with no HTTP status is usually the network, which is
              // worth retrying — but a misconfigured transport and a provider
              // that says it threw the message away are not. Retrying those
              // burns the attempt budget and buries the real fault three
              // failures deep.
              transient: !PERMANENT_NO_STATUS_CODES.has(sent.errorCode ?? ""),
              code: sent.errorCode ?? "provider_unreachable",
            };

      await ctx.runMutation(internal.scheduled.delivery.record, {
        deliveryId,
        status: cls.transient ? "pending" : "failed",
        errorCode: cls.code,
        pdfStatus: pdf.pdfStatus,
        attachment: pdf.attachment,
        ...(cls.transient ? { retryInMs: backoffMs(1) } : {}),
      });
      if (cls.code === "invalid_recipient") {
        await ctx.runMutation(internal.scheduled.delivery.disableEmailForTask, {
          deliveryId,
          reason: "invalid_recipient",
        });
      }
    } catch (e) {
      // The catch-all that makes this action total. An uncaught throw would
      // strand the row in `sending`, and Convex does not retry a thrown action.
      //
      // It used to swallow the exception entirely and record a bare
      // "delivery_error", which made a production failure undiagnosable: the row
      // said something went wrong and nothing said what. Keep the CLASS of the
      // error — a constructor name and a bounded message — so the next failure
      // explains itself. Bounded and logged rather than stored raw, because this
      // field is rendered in the UI.
      const detail =
        e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error("scheduled delivery failed", detail.slice(0, 500));
      await ctx.runMutation(internal.scheduled.delivery.record, {
        deliveryId,
        status: "pending",
        errorCode: `delivery_error:${detail.slice(0, 80)}`,
        pdfStatus: pdf.pdfStatus,
        attachment: pdf.attachment,
        retryInMs: backoffMs(1),
      });
    }
  },
});

/**
 * Render + store the report, and decide whether it can ride along.
 *
 * Never throws: a PDF problem degrades the email, it does not fail delivery and
 * it never touches the occurrence.
 */
async function buildPdf(
  ctx: ActionCtx,
  deliveryId: Id<"scheduledDeliveries">,
  p: {
    title: string;
    prompt: string;
    markdown: string;
    truncated: boolean;
    timezone: string;
    scheduledFor: number;
    startedAt: number | null;
    finishedAt: number | null;
    outcome: string;
    idempotencyKey: string;
  },
  base: string | undefined,
  serviceKey: string | undefined,
): Promise<PdfState> {
  let bytes: ArrayBuffer | null = null;
  if (base && serviceKey) {
    try {
      bytes = await renderPdf(
        base,
        serviceKey,
        {
          title: p.title,
          prompt: p.prompt,
          markdown: p.markdown,
          truncated: p.truncated,
          timezone: p.timezone,
          scheduledFor: p.scheduledFor,
          startedAt: p.startedAt,
          finishedAt: p.finishedAt,
          outcome: p.outcome,
        },
        p.idempotencyKey,
      );
    } catch {
      bytes = null; // timeout / unreachable — degraded, never fatal
    }
  }
  if (!bytes) {
    return {
      pdfStatus: "failed",
      attachment: "skipped_pdf_failed",
      attachmentBase64: null,
    };
  }

  const storageId = await ctx.storage.store(
    new Blob([bytes], { type: "application/pdf" }),
  );
  const slug = p.title.replace(/[^\w.-]+/g, "-").slice(0, 60) || "report";
  await ctx.runMutation(internal.scheduled.delivery.registerReportArtifact, {
    deliveryId,
    storageId,
    filename: `${slug}.pdf`,
    size: bytes.byteLength,
  });

  // Rendered fine, just too large to attach. That is a SUCCESSFUL render with an
  // unattached email — the artifact stays downloadable in-app either way.
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return {
      pdfStatus: "succeeded",
      attachment: "skipped_too_large",
      attachmentBase64: null,
    };
  }
  return {
    pdfStatus: "succeeded",
    attachment: "attached",
    attachmentBase64: toBase64(bytes),
  };
}

/**
 * Stop emailing an address the provider has rejected outright.
 *
 * Without this, every future run of the task retries a dead address, which
 * burns sender reputation for every user on the domain. The user is told
 * in-app, so the setting never changes silently behind their back.
 */
export const disableEmailForTask = internalMutation({
  args: { deliveryId: v.id("scheduledDeliveries"), reason: v.string() },
  handler: async (ctx, { deliveryId, reason }): Promise<void> => {
    const row = await ctx.db.get(deliveryId);
    if (!row) return;
    const task = await ctx.db.get(row.taskId);
    if (!task) return;
    if (task.emailOnSuccess !== true && task.emailOnFailure !== true) return;
    await ctx.db.patch(row.taskId, {
      emailOnSuccess: false,
      emailOnFailure: false,
      updatedAt: Date.now(),
    });
    try {
      await notify(
        ctx,
        row.userId,
        "scheduled.email_disabled",
        `Email turned off for ${task.title}`,
        reason === "bounced"
          ? "The address bounced, so emails for this task were turned off."
          : "The mail provider rejected the address, so emails for this task were turned off.",
        {
          dedupeKey: `${row.occurrenceKey}:email-disabled`,
          taskId: row.taskId,
          occurrenceKey: row.occurrenceKey,
        },
      );
    } catch {
      // A lost notification must never abort turning the setting off.
    }
  },
});

/**
 * Provider webhook outcome: what actually happened after acceptance.
 *
 * Signature verification happens at the HTTP boundary (http.ts); by the time a
 * call reaches here the event is trusted. Idempotent on the provider message
 * id, and it never moves a row backwards out of a terminal delivery state.
 */
export const applyProviderEvent = internalMutation({
  args: {
    providerMessageId: v.string(),
    event: v.union(
      v.literal("delivered"),
      v.literal("bounced"),
      v.literal("complained"),
    ),
  },
  handler: async (ctx, { providerMessageId, event }): Promise<{ ok: boolean }> => {
    const row = await ctx.db
      .query("scheduledDeliveries")
      .withIndex("by_provider_message", (q) =>
        q.eq("providerMessageId", providerMessageId),
      )
      .unique();
    if (!row) return { ok: false };
    // Only `accepted` is awaiting an outcome. A replayed event, or one arriving
    // after a later event already resolved the row, changes nothing.
    if (row.status !== "accepted") return { ok: true };

    await ctx.db.patch(row._id, { status: event, updatedAt: Date.now() });
    if (event === "bounced") {
      await ctx.db.patch(row._id, { errorCode: "hard_bounce" });
      const task = await ctx.db.get(row.taskId);
      if (task && (task.emailOnSuccess === true || task.emailOnFailure === true)) {
        await ctx.db.patch(row.taskId, {
          emailOnSuccess: false,
          emailOnFailure: false,
          updatedAt: Date.now(),
        });
        try {
          await notify(
            ctx,
            row.userId,
            "scheduled.email_disabled",
            `Email turned off for ${task.title}`,
            "The address bounced, so emails for this task were turned off.",
            {
              dedupeKey: `${row.occurrenceKey}:email-disabled`,
              taskId: row.taskId,
              occurrenceKey: row.occurrenceKey,
            },
          );
        } catch {
          // Never abort the bounce handling for a notification.
        }
      }
    }
    return { ok: true };
  },
});

/**
 * RECONCILIATION — finding out what actually happened to a send.
 *
 * Ollastack publishes no outbound delivery webhook and no bounce feed: its
 * `deliveryStatus` enum is `sent | failed | dry_run | scheduled | sending`,
 * with no `delivered` and no `bounced`, and `/failures` is the INBOUND
 * lost-mail trail, not an outbound one. So two things follow, and both are
 * deliberate.
 *
 * FIRST, this never upgrades a row to `delivered`. `accepted` — the provider
 * took custody — stays the strongest honest claim this system can make, which
 * is exactly what delivery-format.ts already tells the user.
 *
 * SECOND, it is nonetheless REQUIRED rather than a nicety. A 2xx from `send`
 * only means the message was stored; it can still end `failed`, and a worker
 * that died between the send and `record` leaves a row that knows nothing at
 * all. Without asking the provider, both are silent failures — the precise
 * thing this whole change exists to eliminate.
 *
 * It is a separate cron from `reap` on purpose: `reap` is a MUTATION and the
 * retry mechanism, so it cannot make network calls, and a bug in reconciliation
 * must not be able to break retries.
 */

/** Rows examined per pass. Bounds both the scan and the provider calls. */
const RECONCILE_SCAN = 25;
/** Younger than this and the provider's drain may not have settled yet. */
const RECONCILE_MIN_AGE_MS = 60_000;
/** Older than this and we stop asking; the row keeps its honest status. */
const RECONCILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A provider status we did not get custody from, as a UI-safe code. */
function reconcileErrorCode(deliveryStatus: string | null): string {
  return deliveryStatus === "dry_run" ? "provider_dry_run" : "reconciled_failed";
}

/**
 * Rows whose true outcome is still unknown, with everything the action needs.
 *
 * The subject is rebuilt here through the SAME `reportSubject` the sender uses,
 * so the two cannot drift. A drifted subject would silently stop matching,
 * which reads as "never sent" and would re-send the report — the one outcome
 * worse than not knowing.
 */
export const reconcileCandidates = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    Array<{
      deliveryId: Id<"scheduledDeliveries">;
      recipient: string;
      subject: string;
      providerMessageId: string | null;
      since: number;
    }>
  > => {
    const now = Date.now();
    const out: Array<{
      deliveryId: Id<"scheduledDeliveries">;
      recipient: string;
      subject: string;
      providerMessageId: string | null;
      since: number;
    }> = [];

    // `accepted` rows keep their claimedAt, so the index bounds the scan to a
    // recent window directly.
    const accepted = await ctx.db
      .query("scheduledDeliveries")
      .withIndex("by_status_claimed", (q) =>
        q.eq("status", "accepted").gt("claimedAt", now - RECONCILE_MAX_AGE_MS),
      )
      .take(RECONCILE_SCAN * 2);

    // `indeterminate` rows had claimedAt cleared by `reap`, so there is no
    // range to bound them with. Newest first, so a backlog of ancient
    // unresolvable rows cannot starve today's.
    const stuck = await ctx.db
      .query("scheduledDeliveries")
      .withIndex("by_status_claimed", (q) => q.eq("status", "indeterminate"))
      .order("desc")
      .take(RECONCILE_SCAN * 2);

    for (const row of [...accepted, ...stuck]) {
      if (out.length >= RECONCILE_SCAN) break;
      // Already concluded once. Only a provider blip leaves this unset, so a
      // transient outage stays eligible for the next pass.
      if (row.reconciledAt !== undefined) continue;
      if (!row.recipient) continue;
      const age = now - row.updatedAt;
      if (age < RECONCILE_MIN_AGE_MS || age > RECONCILE_MAX_AGE_MS) continue;
      const task = await ctx.db.get(row.taskId);
      if (!task) continue;
      out.push({
        deliveryId: row._id,
        recipient: row.recipient,
        subject: reportSubject(task.title, row.outcome),
        providerMessageId: row.providerMessageId ?? null,
        since: row.claimedAt ?? row.createdAt,
      });
    }
    return out;
  },
});

/**
 * Commit one reconciliation verdict.
 *
 * Refuses to act on a row that has moved on while we were asking the provider —
 * only `accepted` and `indeterminate` are reconcilable states.
 */
export const applyReconciliation = internalMutation({
  args: {
    deliveryId: v.id("scheduledDeliveries"),
    resolution: v.union(
      v.literal("confirmed"),
      v.literal("failed"),
      v.literal("never_sent"),
      v.literal("ambiguous"),
    ),
    providerMessageId: v.optional(v.string()),
    errorCode: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<{ ok: boolean }> => {
    const row = await ctx.db.get(a.deliveryId);
    if (!row) return { ok: false };
    if (row.status !== "accepted" && row.status !== "indeterminate") {
      return { ok: false };
    }
    const now = Date.now();

    if (a.resolution === "never_sent") {
      // The provider has no record of it, so nothing left the building and a
      // retry cannot duplicate. This is the ONLY safe re-queue on a transport
      // with no idempotency key — and it is why `indeterminate` is a resolvable
      // state here rather than a dead end.
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        await ctx.db.patch(a.deliveryId, {
          status: "failed",
          errorCode: "attempts_exhausted",
          reconciledAt: now,
          updatedAt: now,
        });
        return { ok: true };
      }
      await ctx.db.patch(a.deliveryId, {
        status: "pending",
        claimedAt: undefined,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.scheduled.delivery.deliver, {
        deliveryId: a.deliveryId,
      });
      return { ok: true };
    }

    if (a.resolution === "ambiguous") {
      // More than one candidate matched. We will not guess which one is this
      // row, and we will not resend. Retire it from future passes carrying the
      // honest label the UI already renders as "Email status unknown".
      await ctx.db.patch(a.deliveryId, {
        status: "indeterminate",
        errorCode: row.errorCode ?? "reconcile_ambiguous",
        reconciledAt: now,
        updatedAt: now,
      });
      return { ok: true };
    }

    if (a.resolution === "failed") {
      await ctx.db.patch(a.deliveryId, {
        status: "failed",
        errorCode: a.errorCode ?? "reconciled_failed",
        providerMessageId: a.providerMessageId ?? row.providerMessageId,
        reconciledAt: now,
        updatedAt: now,
      });
      return { ok: true };
    }

    // confirmed — the provider took custody. Deliberately still `accepted`:
    // Ollastack reports neither delivery nor bounce, so this must NEVER become
    // `delivered`.
    await ctx.db.patch(a.deliveryId, {
      status: "accepted",
      providerMessageId: a.providerMessageId ?? row.providerMessageId,
      reconciledAt: now,
      updatedAt: now,
    });
    return { ok: true };
  },
});

/**
 * One reconciliation pass. Cron-driven, and a no-op on any other transport.
 *
 * Every provider call can return null (blip, timeout, 5xx); null always means
 * "we learned nothing", and a row we learned nothing about is left exactly as
 * it was. Reconciliation may only ever make the record MORE accurate.
 */
export const reconcile = internalAction({
  args: {},
  handler: async (
    ctx: ActionCtx,
  ): Promise<{ checked: number; resolved: number }> => {
    if ((process.env.SCHEDULED_EMAIL_TRANSPORT ?? "disabled") !== "ollastack") {
      return { checked: 0, resolved: 0 };
    }
    const cfg = ollastackConfig();
    const mailboxId = process.env.OLLASTACK_REPORTS_MAILBOX_ID;
    if (!cfg || !mailboxId) return { checked: 0, resolved: 0 };

    const rows = await ctx.runQuery(
      internal.scheduled.delivery.reconcileCandidates,
      {},
    );
    let resolved = 0;

    for (const row of rows) {
      // EXACT path: we recorded a provider id, so ask about that one message.
      // No ambiguity is possible here.
      if (row.providerMessageId) {
        const msg = await fetchMessageById(
          cfg,
          mailboxId,
          row.providerMessageId,
        );
        if (!msg) continue;
        const custody = isCustodyTaken(msg.deliveryStatus);
        await ctx.runMutation(
          internal.scheduled.delivery.applyReconciliation,
          {
            deliveryId: row.deliveryId,
            resolution: custody ? "confirmed" : "failed",
            ...(custody
              ? {}
              : { errorCode: reconcileErrorCode(msg.deliveryStatus) }),
          },
        );
        resolved++;
        continue;
      }

      // SEARCH path: a send that crashed before recording an id. Pinned to the
      // instant we claimed the row, so the candidate set is tiny.
      const matches = await findOutbound(cfg, mailboxId, {
        recipient: row.recipient,
        subject: row.subject,
        since: new Date(row.since - 60_000),
      });
      if (matches === null) continue;

      if (matches.length === 0) {
        await ctx.runMutation(
          internal.scheduled.delivery.applyReconciliation,
          { deliveryId: row.deliveryId, resolution: "never_sent" },
        );
        resolved++;
        continue;
      }
      if (matches.length > 1) {
        await ctx.runMutation(
          internal.scheduled.delivery.applyReconciliation,
          { deliveryId: row.deliveryId, resolution: "ambiguous" },
        );
        resolved++;
        continue;
      }

      const only = matches[0];
      if (!only) continue;
      const custody = isCustodyTaken(only.deliveryStatus);
      await ctx.runMutation(internal.scheduled.delivery.applyReconciliation, {
        deliveryId: row.deliveryId,
        resolution: custody ? "confirmed" : "failed",
        providerMessageId: only.id,
        ...(custody
          ? {}
          : { errorCode: reconcileErrorCode(only.deliveryStatus) }),
      });
      resolved++;
    }

    return { checked: rows.length, resolved };
  },
});
