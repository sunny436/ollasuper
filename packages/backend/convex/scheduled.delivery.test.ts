/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Phase 4 delivery.
 *
 * The properties under test are the ones that would ship a defect if wrong:
 * delivery fires from EVERY terminal path that ran and none that did not; a
 * delivery failure never touches the occurrence; the decision is snapshotted so
 * a mid-flight preference change cannot retarget it; and nothing here can send
 * an email twice.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
type TestT = TestConvex<typeof schema>;

const DAILY = { kind: "daily" as const, timezone: "UTC", hour: 9, minute: 0 };

const realFetch = globalThis.fetch;

/** Records every outbound call so a test can assert how many emails were sent. */
let sent: { url: string; idempotencyKey: string | null }[] = [];
let nextEmailStatus = 200;

beforeEach(() => {
  sent = [];
  nextEmailStatus = 200;
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "test-service-key";
  process.env.SCHEDULED_DELIVERY_ENABLED = "true";
  process.env.SCHEDULED_EMAIL_TRANSPORT = "resend";
  process.env.RESEND_API_KEY = "re_test_key";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.resend.com")) {
      const headers = new Headers(init?.headers);
      sent.push({ url, idempotencyKey: headers.get("Idempotency-Key") });
      if (nextEmailStatus !== 200) {
        return new Response("{}", { status: nextEmailStatus });
      }
      return new Response(JSON.stringify({ id: `msg_${sent.length}` }), {
        status: 200,
      });
    }
    if (url.includes("/v1/report/pdf")) {
      return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
    }
    return new Response(JSON.stringify({ accepted: true }), { status: 202 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of [
    "AI_BASE_URL",
    "AI_SERVICE_KEY",
    "SCHEDULED_DELIVERY_ENABLED",
    "SCHEDULED_EMAIL_TRANSPORT",
    "RESEND_API_KEY",
  ]) {
    delete process.env[k];
  }
});

async function drain(t: TestT) {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seed(t: TestT, opts: { verified?: boolean } = {}) {
  const verified = opts.verified !== false;
  const { userId, ws } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "owner@test.test",
      ...(verified ? { emailVerificationTime: Date.now() } : {}),
    });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId,
      role: "owner",
      createdAt: Date.now(),
    });
    return { userId, ws };
  });
  return { userId, ws, u: t.withIdentity(as(userId)) };
}

async function mkTask(
  t: TestT,
  userId: Id<"users">,
  ws: Id<"workspaces">,
  email: { onSuccess?: boolean; onFailure?: boolean; pdf?: boolean } = {},
) {
  const taskId = await t
    .withIdentity(as(userId))
    .mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: "Daily digest",
      prompt: "Summarise my inbox",
      spec: DAILY,
    });
  await t.run(async (ctx) => {
    await ctx.db.patch(taskId, {
      emailOnSuccess: email.onSuccess,
      emailOnFailure: email.onFailure,
      attachPdf: email.pdf,
    });
  });
  return taskId;
}

async function claimOne(
  t: TestT,
  userId: Id<"users">,
  taskId: Id<"scheduledTasks">,
) {
  await t
    .withIdentity(as(userId))
    .mutation(api.scheduled.tasks.runNow, { taskId });
  const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
    limit: 1,
    maxPerUser: 1,
  });
  return claims[0];
}

const deliveries = (t: TestT) =>
  t.run(async (ctx) => ctx.db.query("scheduledDeliveries").collect());

/**
 * Drive the occurrence through a REAL turn so it ends up with an answer.
 *
 * Goes through startRun + finishStream rather than patching the message, because
 * that is also what mints the streamId — and the report artifact is registered
 * against the occurrence's own stream, so a hand-patched message would leave the
 * artifact path untested.
 */
async function withResult(
  t: TestT,
  claim: { occurrenceKey: string; leaseToken: string },
  text: string,
) {
  const started = await t.mutation(internal.scheduled.execution.startRun, {
    occurrenceKey: claim.occurrenceKey,
    leaseToken: claim.leaseToken,
  });
  await drain(t);
  await t.mutation(internal.chat.ingest.finishStream, {
    streamId: String(started.streamId),
    text,
  });
}

// ---------------------------------------------------------------------------
// Opt-in. Deploying Phase 4 must not make one existing task email anyone.
// ---------------------------------------------------------------------------
describe("email is opt-in", () => {
  test("a task with no email preference creates no delivery at all", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws); // no prefs — the pre-Phase-4 shape
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    expect(await deliveries(t)).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("emailOnSuccess does not imply emailOnFailure", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "failed",
      retryable: false,
    });
    await drain(t);
    expect(await deliveries(t)).toEqual([]);
  });

  test("a cancelled run follows the FAILURE preference", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onFailure: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "cancelled",
    });
    await drain(t);
    const rows = await deliveries(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// P2 — reapStalled is a SECOND terminal site. Hooking only finalize would mean
// a run whose worker died notifies but never delivers.
// ---------------------------------------------------------------------------
describe("delivery fires from every terminal path that ran", () => {
  test("finalize enqueues a delivery", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    expect(await deliveries(t)).toHaveLength(1);
  });

  test("reapStalled ALSO enqueues a delivery (P2)", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onFailure: true });
    const claim = await claimOne(t, userId, taskId);
    // The worker dies: no heartbeat, and the lease ages past its TTL.
    await t.run(async (ctx) => {
      const occ = await ctx.db
        .query("scheduledTaskOccurrences")
        .withIndex("by_occurrence_key", (q) =>
          q.eq("occurrenceKey", claim.occurrenceKey),
        )
        .unique();
      if (!occ) throw new Error("missing occurrence");
      await ctx.db.patch(occ._id, {
        heartbeatAt: Date.now() - 10 * 60_000,
        attempts: 2, // one short of MAX_ATTEMPTS, so the reap is terminal
      });
    });
    const res = await t.mutation(internal.scheduled.occurrences.reapStalled, {});
    expect(res.closed).toBe(1);
    await drain(t);
    const rows = await deliveries(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("failed");
  });

  test("a run that never STARTED produces no delivery", async () => {
    // Deleting a task cancels its queued occurrences. There is no result to
    // report and the user caused it, so emailing them would be noise.
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws, {
      onSuccess: true,
      onFailure: true,
    });
    await u.mutation(api.scheduled.tasks.runNow, { taskId });
    await u.mutation(api.scheduled.tasks.remove, { taskId });
    await drain(t);
    expect(await deliveries(t)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P4 — Convex has no unique constraints. Uniqueness is a read-then-insert in
// one serialisable mutation.
// ---------------------------------------------------------------------------
describe("one delivery per occurrence", () => {
  test("a replayed finalize does not create a second delivery", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    const args = {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded" as const,
    };
    await t.mutation(internal.scheduled.occurrences.finalize, args);
    const again = await t.mutation(
      internal.scheduled.occurrences.finalize,
      args,
    );
    expect(again.alreadyTerminal).toBe(true);
    await drain(t);
    expect(await deliveries(t)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  test("finalize then reapStalled cannot both deliver", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await t.mutation(internal.scheduled.occurrences.reapStalled, {});
    await drain(t);
    expect(await deliveries(t)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// P8 — the decision is snapshotted inside the terminal transaction.
// ---------------------------------------------------------------------------
describe("the delivery decision is a snapshot", () => {
  test("turning email off after finalize does not cancel the delivery", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    // The user toggles the preference before the queued action runs.
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId, { emailOnSuccess: false });
    });
    await drain(t);
    const rows = await deliveries(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("accepted");
    expect(sent).toHaveLength(1);
  });

  test("deleting the task after finalize does not strand the delivery", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await u.mutation(api.scheduled.tasks.remove, { taskId });
    await drain(t);
    const rows = await deliveries(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("accepted");
  });

  test("the recipient is the owner's VERIFIED address, or the delivery skips", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t, { verified: false });
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    const rows = await deliveries(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].errorCode).toBe("no_verified_recipient");
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Failure isolation: delivery must never reach back into execution.
// ---------------------------------------------------------------------------
describe("a delivery failure never re-runs the AI", () => {
  test("a provider 500 leaves the occurrence succeeded and its attempts alone", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    nextEmailStatus = 500;
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);

    const { page } = await u.query(api.scheduled.tasks.history, { taskId });
    expect(page).toHaveLength(1);
    expect(page[0].status).toBe("succeeded");
    expect(page[0].attempts).toBe(1);

    const rows = await deliveries(t);
    // Transient: back to pending for the reaper, not failed.
    expect(rows[0].status).toBe("pending");
    expect(rows[0].errorCode).toBe("provider_5xx");
  });

  test("an invalid recipient is permanent and turns the task's email off", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, {
      onSuccess: true,
      onFailure: true,
    });
    const claim = await claimOne(t, userId, taskId);
    nextEmailStatus = 422;
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);

    const rows = await deliveries(t);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorCode).toBe("invalid_recipient");
    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task?.emailOnSuccess).toBe(false);
    expect(task?.emailOnFailure).toBe(false);
  });

  test("a PDF failure still sends the email, and the run stays succeeded", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true, pdf: true });
    const claim = await claimOne(t, userId, taskId);
    await withResult(t, claim, "# Report\n\nAll good.");
    // The renderer is down; everything else is fine.
    const withFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/v1/report/pdf")) {
        return new Response("boom", { status: 500 });
      }
      return withFetch(input, init);
    }) as typeof fetch;

    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);

    const rows = await deliveries(t);
    expect(rows[0].pdfStatus).toBe("failed");
    expect(rows[0].attachment).toBe("skipped_pdf_failed");
    expect(rows[0].status).toBe("accepted");
    const { page } = await u.query(api.scheduled.tasks.history, { taskId });
    expect(page[0].status).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// P1 — the fail-closed transport. This is the one that would have quietly sent
// every production report into Mailpit.
// ---------------------------------------------------------------------------
describe("email transport is fail-closed", () => {
  test("resend with no key FAILS; it never falls back to SMTP", async () => {
    const t = convexTest(schema, modules);
    // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
    delete process.env.RESEND_API_KEY;
    process.env.SMTP_HOST = "127.0.0.1"; // a Mailpit-shaped trap
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    const rows = await deliveries(t);
    expect(rows[0].errorCode).toBe("resend_key_missing");
    expect(rows[0].status).not.toBe("accepted");
    expect(sent).toEqual([]);
    // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
    delete process.env.SMTP_HOST;
  });

  test("delivery disabled records skipped and sends nothing", async () => {
    const t = convexTest(schema, modules);
    process.env.SCHEDULED_DELIVERY_ENABLED = "false";
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    const rows = await deliveries(t);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].errorCode).toBe("delivery_disabled");
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P3 — accepted is not delivered.
// ---------------------------------------------------------------------------
describe("accepted vs delivered", () => {
  test("a 2xx records `accepted`, never `delivered`", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    const rows = await deliveries(t);
    expect(rows[0].status).toBe("accepted");
    expect(rows[0].providerMessageId).toBe("msg_1");
  });

  test("a webhook promotes accepted -> delivered, idempotently", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    for (let i = 0; i < 2; i++) {
      await t.mutation(internal.scheduled.delivery.applyProviderEvent, {
        providerMessageId: "msg_1",
        event: "delivered",
      });
    }
    const rows = await deliveries(t);
    expect(rows[0].status).toBe("delivered");
  });

  test("a hard bounce turns the task's email off", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, {
      onSuccess: true,
      onFailure: true,
    });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    await t.mutation(internal.scheduled.delivery.applyProviderEvent, {
      providerMessageId: "msg_1",
      event: "bounced",
    });
    const rows = await deliveries(t);
    expect(rows[0].status).toBe("bounced");
    const task = await t.run(async (ctx) => ctx.db.get(taskId));
    expect(task?.emailOnSuccess).toBe(false);
    // The user is told, rather than the setting changing silently.
    const notes = await t.run(async (ctx) =>
      ctx.db.query("notifications").collect(),
    );
    expect(notes.some((n) => n.type === "scheduled.email_disabled")).toBe(true);
  });

  test("a late event cannot move a resolved row backwards", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    await t.mutation(internal.scheduled.delivery.applyProviderEvent, {
      providerMessageId: "msg_1",
      event: "bounced",
    });
    await t.mutation(internal.scheduled.delivery.applyProviderEvent, {
      providerMessageId: "msg_1",
      event: "delivered",
    });
    const rows = await deliveries(t);
    expect(rows[0].status).toBe("bounced");
  });
});

// ---------------------------------------------------------------------------
// P5 — a thrown action is not retried, so the reaper IS the retry mechanism.
// ---------------------------------------------------------------------------
describe("the reaper is the retry mechanism", () => {
  test("a row stuck in `sending` inside the idempotency window is retried", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    // Simulate a worker that died mid-send, 3 minutes ago: past the lease, well
    // inside the provider's idempotency window.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("scheduledDeliveries").collect())[0];
      await ctx.db.patch(row._id, {
        status: "sending",
        claimedAt: Date.now() - 3 * 60_000,
        attempts: 1,
      });
    });
    const res = await t.mutation(internal.scheduled.delivery.reap, {});
    expect(res.requeued).toBe(1);
    expect(res.indeterminate).toBe(0);
  });

  test("beyond the window it becomes `indeterminate` and is NOT resent", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    const before = sent.length;
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("scheduledDeliveries").collect())[0];
      await ctx.db.patch(row._id, {
        status: "sending",
        claimedAt: Date.now() - 60 * 60_000, // an hour ago
        attempts: 1,
      });
    });
    const res = await t.mutation(internal.scheduled.delivery.reap, {});
    expect(res.indeterminate).toBe(1);
    await drain(t);
    // We prefer a possibly-lost email to a possible duplicate.
    expect(sent.length).toBe(before);
    const rows = await deliveries(t);
    expect(rows[0].status).toBe("indeterminate");
    expect(rows[0].errorCode).toBe("worker_lost_after_send");
  });

  test("attempts are bounded — an endlessly failing delivery gives up", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("scheduledDeliveries").collect())[0];
      await ctx.db.patch(row._id, {
        status: "pending",
        attempts: 3,
        claimedAt: undefined,
        updatedAt: Date.now() - 10 * 60_000,
      });
    });
    await t.mutation(internal.scheduled.delivery.reap, {});
    const rows = await deliveries(t);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorCode).toBe("attempts_exhausted");
  });
});

// ---------------------------------------------------------------------------
// The Idempotency-Key is what buys provider-side duplicate suppression.
// ---------------------------------------------------------------------------
describe("idempotency", () => {
  test("the send carries a stable per-occurrence Idempotency-Key", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].idempotencyKey).toBe(`${claim.occurrenceKey}:email`);
  });

  test("a 409 from the provider is treated as already-sent, not retried", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    nextEmailStatus = 409;
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    const rows = await deliveries(t);
    expect(rows[0].status).toBe("accepted");
    expect(sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PDF outcomes. "Rendered but too big to attach" is a SUCCESSFUL render with an
// unattached email — not a failure — and the artifact stays downloadable.
// ---------------------------------------------------------------------------
describe("PDF attachment outcomes", () => {
  async function runWithPdfBytes(t: TestT, bytes: Uint8Array | null) {
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true, pdf: true });
    const claim = await claimOne(t, userId, taskId);
    await withResult(t, claim, "# Weekly report\n\n- one\n- two");
    const base = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).includes("/v1/report/pdf")) {
        return bytes
          ? new Response(bytes, { status: 200 })
          : new Response("no", { status: 500 });
      }
      return base(i, init);
    }) as typeof fetch;
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    return { taskId, claim };
  }

  test("a small PDF is attached and registered as an artifact", async () => {
    const t = convexTest(schema, modules);
    await runWithPdfBytes(t, new Uint8Array([37, 80, 68, 70, 1, 2, 3]));
    const rows = await deliveries(t);
    expect(rows[0].pdfStatus).toBe("succeeded");
    expect(rows[0].attachment).toBe("attached");
    expect(rows[0].status).toBe("accepted");
    expect(rows[0].pdfArtifactId).toBeDefined();

    const artifacts = await t.run(async (ctx) =>
      ctx.db.query("chatArtifacts").collect(),
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].format).toBe("pdf");
    // Owner-scoped from the occurrence, never from the request.
    expect(artifacts[0].userId).toBe(rows[0].userId);
  });

  test("an oversized PDF is STILL stored; only the attachment is dropped", async () => {
    const t = convexTest(schema, modules);
    await runWithPdfBytes(t, new Uint8Array(9 * 1024 * 1024));
    const rows = await deliveries(t);
    // The render worked. Calling this a PDF failure would be wrong.
    expect(rows[0].pdfStatus).toBe("succeeded");
    expect(rows[0].attachment).toBe("skipped_too_large");
    expect(rows[0].status).toBe("accepted");

    const artifacts = await t.run(async (ctx) =>
      ctx.db.query("chatArtifacts").collect(),
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].size).toBe(9 * 1024 * 1024);
  });

  test("a run with no text renders no PDF and still emails", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true, pdf: true });
    const claim = await claimOne(t, userId, taskId);
    // Deliberately no withResult(): the assistant message is empty.
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    const rows = await deliveries(t);
    expect(rows[0].pdfStatus).toBe("none");
    expect(rows[0].status).toBe("accepted");
    expect(
      await t.run(async (ctx) => ctx.db.query("chatArtifacts").collect()),
    ).toEqual([]);
  });

  test("a re-render reuses the artifact instead of duplicating the blob", async () => {
    const t = convexTest(schema, modules);
    const { claim } = await runWithPdfBytes(
      t,
      new Uint8Array([37, 80, 68, 70, 9]),
    );
    const first = await t.run(async (ctx) =>
      ctx.db.query("chatArtifacts").collect(),
    );
    expect(first).toHaveLength(1);

    // A delivery retry renders again. by_stream_key dedupe must return the
    // EXISTING row and drop the duplicate blob.
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([1])])),
    );
    const row = (await deliveries(t))[0];
    const res = await t.mutation(
      internal.scheduled.delivery.registerReportArtifact,
      { deliveryId: row._id, storageId, filename: "again.pdf", size: 1 },
    );
    expect(res.artifactId).toBe(first[0]._id);
    const after = await t.run(async (ctx) =>
      ctx.db.query("chatArtifacts").collect(),
    );
    expect(after).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Content safety. The task title reaches a mail header; the result reaches HTML.
// ---------------------------------------------------------------------------
describe("email content is sanitised", () => {
  test("a task title cannot inject a header or an unbounded subject", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await t
      .withIdentity(as(userId))
      .mutation(api.scheduled.tasks.create, {
        workspaceId: ws,
        title: `Digest\r\nBcc: attacker@evil.test\n${"x".repeat(400)}`,
        prompt: "Summarise",
        spec: DAILY,
      });
    await t.run(async (ctx) => {
      await ctx.db.patch(taskId, { emailOnSuccess: true });
    });
    const claim = await claimOne(t, userId, taskId);
    await withResult(t, claim, "ok");
    let body: Record<string, unknown> = {};
    const base = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).includes("api.resend.com")) {
        body = JSON.parse(String(init?.body ?? "{}"));
      }
      return base(i, init);
    }) as typeof fetch;
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    const subject = String(body.subject ?? "");
    expect(subject).not.toContain("\r");
    expect(subject).not.toContain("\n");
    expect(subject.length).toBeLessThanOrEqual(120);
  });

  test("model-authored HTML in the result cannot emit tags", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws, { onSuccess: true });
    const claim = await claimOne(t, userId, taskId);
    await withResult(
      t,
      claim,
      '<img src=x onerror="alert(1)"> and <script>steal()</script>',
    );
    let body: Record<string, unknown> = {};
    const base = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).includes("api.resend.com")) {
        body = JSON.parse(String(init?.body ?? "{}"));
      }
      return base(i, init);
    }) as typeof fetch;
    await t.mutation(internal.scheduled.occurrences.finalize, {
      occurrenceKey: claim.occurrenceKey,
      leaseToken: claim.leaseToken,
      outcome: "succeeded",
    });
    await drain(t);
    const html = String(body.html ?? "");
    // The precise property: after removing the tags WE emit, no markup is left.
    // Asserting on substrings like "onerror" would be wrong — that word is fine
    // as escaped text, and the user should still see what the model wrote.
    const withoutOurTags = html.replace(
      /<\/?(?:h[1-3]|p|ul|ol|li|em|strong|code|pre|a)(?:\s[^>]*)?>/g,
      "",
    );
    expect(withoutOurTags).not.toContain("<");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    // Escaped, not stripped.
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });
});
