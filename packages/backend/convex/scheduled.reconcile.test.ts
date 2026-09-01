/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * RECONCILIATION.
 *
 * Ollastack accepts a send and reports `sent`/`failed` afterwards, with no
 * delivery webhook and no bounce feed. So two situations are silent failures
 * unless we go and ask:
 *
 *   1. a send that was accepted and then failed in the provider's drain, and
 *   2. a send whose worker died before it could record the provider id — the
 *      crash window that has no idempotency key to protect it.
 *
 * The properties under test are the ones that decide whether a user is lied to
 * or double-emailed: never claim `delivered`, never resend without proof that
 * nothing was sent, and never move a row at all on a provider blip.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
type TestT = TestConvex<typeof schema>;

const DAILY = { kind: "daily" as const, timezone: "UTC", hour: 9, minute: 0 };
const MAILBOX = "mb_test";
const TITLE = "Daily digest";
/** What email.ts builds for a succeeded run — reconcile must rebuild it exactly. */
const SUBJECT = TITLE;

const realFetch = globalThis.fetch;

/** The provider's outbound log, as this test wants it to look. */
let outbox: Array<{
  id: string;
  subject: string | null;
  toAddresses: string[];
  deliveryStatus: string | null;
}> = [];
/** Simulates the provider being unreachable: every GET returns a 500. */
let providerDown = false;
let searchCalls = 0;

beforeEach(() => {
  outbox = [];
  providerDown = false;
  searchCalls = 0;
  process.env.SCHEDULED_DELIVERY_ENABLED = "true";
  process.env.SCHEDULED_EMAIL_TRANSPORT = "ollastack";
  process.env.OLLASTACK_MAIL_TOKEN = "fmd_test_token";
  process.env.OLLASTACK_REPORTS_MAILBOX_ID = MAILBOX;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes(`/api/mailboxes/${MAILBOX}/messages`)) {
      if (providerDown) return new Response("nope", { status: 500 });
      // Exact-id lookup: /messages/<id>, no query string.
      const exact = /\/messages\/([^/?]+)$/.exec(url);
      if (exact) {
        const hit = outbox.find((m) => m.id === exact[1]);
        if (!hit) return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({ success: true, data: hit }), {
          status: 200,
        });
      }
      // Search. The action filters on subject + recipient itself, so this
      // returns the whole outbox and lets the real matching logic run.
      searchCalls++;
      return new Response(
        JSON.stringify({ success: true, data: { messages: outbox } }),
        { status: 200 },
      );
    }
    if (url.includes("/send")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: { id: "msg_live", deliveryStatus: "sent" },
        }),
        { status: 200 },
      );
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
    "SCHEDULED_DELIVERY_ENABLED",
    "SCHEDULED_EMAIL_TRANSPORT",
    "OLLASTACK_MAIL_TOKEN",
    "OLLASTACK_REPORTS_MAILBOX_ID",
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

const deliveries = (t: TestT) =>
  t.run(async (ctx) => ctx.db.query("scheduledDeliveries").collect());

/** A real delivery row, produced by the real pipeline, then posed. */
async function seedDelivery(
  t: TestT,
  pose: {
    status: "accepted" | "indeterminate";
    providerMessageId?: string;
    ageMs?: number;
  },
) {
  const { userId, ws } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "owner@test.test",
      emailVerificationTime: Date.now(),
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
  const taskId = await t
    .withIdentity(as(userId))
    .mutation(api.scheduled.tasks.create, {
      workspaceId: ws,
      title: TITLE,
      prompt: "Summarise my inbox",
      spec: DAILY,
    });
  await t.run(async (ctx) => {
    await ctx.db.patch(taskId, { emailOnSuccess: true });
  });
  await t
    .withIdentity(as(userId))
    .mutation(api.scheduled.tasks.runNow, { taskId });
  const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
    limit: 1,
    maxPerUser: 1,
  });
  const claim = claims[0];
  await t.mutation(internal.scheduled.occurrences.finalize, {
    occurrenceKey: claim.occurrenceKey,
    leaseToken: claim.leaseToken,
    outcome: "succeeded",
  });
  await drain(t);

  // Pose the row. `updatedAt` is backdated past RECONCILE_MIN_AGE_MS, because a
  // row younger than that is deliberately left alone to settle.
  const deliveryId = await t.run(async (ctx) => {
    const row = (await ctx.db.query("scheduledDeliveries").collect())[0];
    await ctx.db.patch(row._id, {
      status: pose.status,
      providerMessageId: pose.providerMessageId,
      claimedAt: Date.now() - (pose.ageMs ?? 5 * 60_000),
      updatedAt: Date.now() - (pose.ageMs ?? 5 * 60_000),
      reconciledAt: undefined,
    });
    return row._id;
  });
  return { deliveryId, taskId, userId };
}

describe("reconciliation resolves a crashed send", () => {
  test("no matching outbound message ⇒ nothing was sent ⇒ safe to re-queue", async () => {
    const t = convexTest(schema, modules);
    const { deliveryId } = await seedDelivery(t, { status: "indeterminate" });
    outbox = []; // the provider has no record of it

    const res = await t.action(internal.scheduled.delivery.reconcile, {});
    expect(res.checked).toBe(1);
    expect(res.resolved).toBe(1);

    const row = await t.run(async (ctx) => ctx.db.get(deliveryId));
    expect(row?.status).toBe("pending");
    // Flush the re-queued send so the run leaves no scheduled work dangling.
    await drain(t);
  });

  test("one match that was sent ⇒ accepted, with the real provider id", async () => {
    const t = convexTest(schema, modules);
    const { deliveryId } = await seedDelivery(t, { status: "indeterminate" });
    outbox = [
      {
        id: "msg_real",
        subject: SUBJECT,
        toAddresses: ["owner@test.test"],
        deliveryStatus: "sent",
      },
    ];

    await t.action(internal.scheduled.delivery.reconcile, {});
    const row = await t.run(async (ctx) => ctx.db.get(deliveryId));
    expect(row?.status).toBe("accepted");
    expect(row?.providerMessageId).toBe("msg_real");
    // The whole point: custody is all we know. Never "delivered".
    expect(row?.status).not.toBe("delivered");
    expect(row?.reconciledAt).toBeTypeOf("number");
  });

  test("one match that failed ⇒ recorded as failed, not silently accepted", async () => {
    const t = convexTest(schema, modules);
    const { deliveryId } = await seedDelivery(t, { status: "indeterminate" });
    outbox = [
      {
        id: "msg_dead",
        subject: SUBJECT,
        toAddresses: ["owner@test.test"],
        deliveryStatus: "failed",
      },
    ];

    await t.action(internal.scheduled.delivery.reconcile, {});
    const row = await t.run(async (ctx) => ctx.db.get(deliveryId));
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("reconciled_failed");
  });

  test("a dry_run match is a failure and says so", async () => {
    const t = convexTest(schema, modules);
    const { deliveryId } = await seedDelivery(t, { status: "indeterminate" });
    outbox = [
      {
        id: "msg_swallowed",
        subject: SUBJECT,
        toAddresses: ["owner@test.test"],
        deliveryStatus: "dry_run",
      },
    ];

    await t.action(internal.scheduled.delivery.reconcile, {});
    const row = await t.run(async (ctx) => ctx.db.get(deliveryId));
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("provider_dry_run");
  });

  /**
   * The conservative branch. Two identical candidates means we cannot tell
   * which one is this row, so we refuse to resolve rather than risk either a
   * duplicate report or a false "failed".
   */
  test("more than one match ⇒ stays indeterminate and is never resent", async () => {
    const t = convexTest(schema, modules);
    const { deliveryId } = await seedDelivery(t, { status: "indeterminate" });
    outbox = [
      {
        id: "msg_a",
        subject: SUBJECT,
        toAddresses: ["owner@test.test"],
        deliveryStatus: "sent",
      },
      {
        id: "msg_b",
        subject: SUBJECT,
        toAddresses: ["owner@test.test"],
        deliveryStatus: "sent",
      },
    ];

    await t.action(internal.scheduled.delivery.reconcile, {});
    const row = await t.run(async (ctx) => ctx.db.get(deliveryId));
    expect(row?.status).toBe("indeterminate");
    expect(row?.errorCode).toBe("reconcile_ambiguous");
    // Retired from future passes, so it cannot starve the scan forever.
    expect(row?.reconciledAt).toBeTypeOf("number");
  });

  test("a message for a DIFFERENT recipient is not a match", async () => {
    const t = convexTest(schema, modules);
    const { deliveryId } = await seedDelivery(t, { status: "indeterminate" });
    outbox = [
      {
        id: "msg_other",
        subject: SUBJECT,
        toAddresses: ["someone.else@test.test"],
        deliveryStatus: "sent",
      },
    ];

    await t.action(internal.scheduled.delivery.reconcile, {});
    const row = await t.run(async (ctx) => ctx.db.get(deliveryId));
    // Correctly reads as "never sent", so it re-queues rather than adopting
    // another row's message.
    expect(row?.status).toBe("pending");
    await drain(t);
  });
});

describe("reconciliation only ever improves the record", () => {
  test("a provider outage changes nothing at all", async () => {
    const t = convexTest(schema, modules);
    const { deliveryId } = await seedDelivery(t, { status: "indeterminate" });
    providerDown = true;

    const res = await t.action(internal.scheduled.delivery.reconcile, {});
    expect(res.resolved).toBe(0);
    const row = await t.run(async (ctx) => ctx.db.get(deliveryId));
    expect(row?.status).toBe("indeterminate");
    // Still eligible for the next pass — an outage must not retire a row.
    expect(row?.reconciledAt).toBeUndefined();
  });

  test("an accepted row whose message later failed is corrected", async () => {
    const t = convexTest(schema, modules);
    const { deliveryId } = await seedDelivery(t, {
      status: "accepted",
      providerMessageId: "msg_live",
    });
    outbox = [
      {
        id: "msg_live",
        subject: SUBJECT,
        toAddresses: ["owner@test.test"],
        deliveryStatus: "failed",
      },
    ];

    await t.action(internal.scheduled.delivery.reconcile, {});
    const row = await t.run(async (ctx) => ctx.db.get(deliveryId));
    expect(row?.status).toBe("failed");
    // Resolved by exact id, so no search was needed.
    expect(searchCalls).toBe(0);
  });

  test("an accepted row that really did send stays accepted, and is not re-checked", async () => {
    const t = convexTest(schema, modules);
    const { deliveryId } = await seedDelivery(t, {
      status: "accepted",
      providerMessageId: "msg_live",
    });
    outbox = [
      {
        id: "msg_live",
        subject: SUBJECT,
        toAddresses: ["owner@test.test"],
        deliveryStatus: "sent",
      },
    ];

    await t.action(internal.scheduled.delivery.reconcile, {});
    const first = await t.run(async (ctx) => ctx.db.get(deliveryId));
    expect(first?.status).toBe("accepted");
    expect(first?.reconciledAt).toBeTypeOf("number");

    // Second pass must find nothing left to do.
    const res = await t.action(internal.scheduled.delivery.reconcile, {});
    expect(res.checked).toBe(0);
  });

  test("a row younger than the settle window is left alone", async () => {
    const t = convexTest(schema, modules);
    await seedDelivery(t, { status: "indeterminate", ageMs: 5_000 });
    const res = await t.action(internal.scheduled.delivery.reconcile, {});
    expect(res.checked).toBe(0);
  });

  test("reconcile is a no-op on any other transport", async () => {
    const t = convexTest(schema, modules);
    await seedDelivery(t, { status: "indeterminate" });
    process.env.SCHEDULED_EMAIL_TRANSPORT = "smtp";
    const res = await t.action(internal.scheduled.delivery.reconcile, {});
    expect(res).toEqual({ checked: 0, resolved: 0 });
  });

  test("reconcile is a no-op when the transport is unconfigured", async () => {
    const t = convexTest(schema, modules);
    await seedDelivery(t, { status: "indeterminate" });
    // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
    delete process.env.OLLASTACK_MAIL_TOKEN;
    const res = await t.action(internal.scheduled.delivery.reconcile, {});
    expect(res).toEqual({ checked: 0, resolved: 0 });
  });
});

describe("the re-queue actually completes the delivery", () => {
  test("a never-sent row goes on to send exactly one email", async () => {
    const t = convexTest(schema, modules);
    const { deliveryId } = await seedDelivery(t, { status: "indeterminate" });
    outbox = [];

    await t.action(internal.scheduled.delivery.reconcile, {});
    await drain(t);

    const row = await t.run(async (ctx) => ctx.db.get(deliveryId));
    expect(row?.status).toBe("accepted");
    expect(row?.providerMessageId).toBe("msg_live");
    expect(await deliveries(t)).toHaveLength(1);
  });
});
