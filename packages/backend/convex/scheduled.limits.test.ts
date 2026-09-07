/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { DEFAULT_MODEL } from "./chat/authz";

/**
 * Phase 4 limits and the provider webhook.
 *
 * The scheduled-execution window is the piece with a real failure mode: get it
 * wrong in the obvious way (enforce at start, fail the turn) and hitting a limit
 * silently burns retry budget on work the user never mis-scheduled.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
type TestT = TestConvex<typeof schema>;
const DAILY = { kind: "daily" as const, timezone: "UTC", hour: 9, minute: 0 };

/** Computed-key delete: biome flags the literal form, not this one, and six
 *  suppressions would be worse than one helper. */
function unsetEnv(key: string) {
  delete process.env[key];
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.AI_BASE_URL = "http://ai.invalid:8000";
  process.env.AI_SERVICE_KEY = "test-service-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ accepted: true }), {
      status: 202,
    })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ["AI_BASE_URL", "AI_SERVICE_KEY"]) {
    delete process.env[k];
  }
});

async function seed(t: TestT) {
  const { userId, ws } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "o@t.test" });
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

async function mkTask(t: TestT, userId: Id<"users">, ws: Id<"workspaces">) {
  return t.withIdentity(as(userId)).mutation(api.scheduled.tasks.create, {
    workspaceId: ws,
    title: "Digest",
    prompt: "Summarise",
    spec: DAILY,
  });
}

/** Spend the user's scheduled window without running anything. */
const quotaRow = (t: TestT, userId: Id<"users">, kind: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query("userQuotas")
      .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", kind))
      .unique(),
  );

async function exhaustWindow(
  t: TestT,
  userId: Id<"users">,
  ws: Id<"workspaces">,
) {
  // The window lives in userQuotas now, keyed on the USER alone — it moved off
  // chatSettings because that row is per-workspace and user-deletable, so a
  // second workspace or a preferences reset handed back a fresh allowance.
  void ws;
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("userQuotas")
      .withIndex("by_user_kind", (q) =>
        q.eq("userId", userId).eq("kind", "schedRun"),
      )
      .unique();
    const next = { windowStart: Date.now(), windowCount: 60 };
    if (row) await ctx.db.patch(row._id, next);
    else
      await ctx.db.insert("userQuotas", { userId, kind: "schedRun", ...next });
  });
}

/**
 * Run scheduled functions to completion inside the test.
 *
 * These tests drive occurrence claims, which create messages, which schedule
 * chat.stream.dispatch. finishInProgressScheduledFunctions() only awaits
 * functions that have already STARTED, and a ctx.scheduler.runAfter(0, ...) is
 * queued on a macrotask — so the event loop has to be yielded first. Without
 * this the dispatch starts after the test's transaction has closed and surfaces
 * as an unhandled "Write outside of transaction", which made the whole suite
 * exit 1 while every assertion passed. Mirrors chat.security.test.ts.
 */
async function drain(t: ReturnType<typeof convexTest>) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

describe("the scheduled-execution window queues rather than drops", () => {
  test("an exhausted window leaves the occurrence QUEUED, not failed", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    await exhaustWindow(t, userId, ws);

    await u.mutation(api.scheduled.tasks.runNow, { taskId });
    const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 5,
      maxPerUser: 1,
    });
    expect(claims).toEqual([]);

    const occ = await t.run(async (ctx) =>
      ctx.db.query("scheduledTaskOccurrences").first(),
    );
    // Still durable, still owed, and no attempt was burned on a limit the user
    // did not cause.
    expect(occ?.status).toBe("queued");
    expect(occ?.attempts).toBe(0);
    await drain(t);
  });

  test("it runs as soon as the window rolls — nothing is lost", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    await exhaustWindow(t, userId, ws);
    await u.mutation(api.scheduled.tasks.runNow, { taskId });
    expect(
      (
        await t.mutation(internal.scheduled.occurrences.claim, {
          limit: 5,
          maxPerUser: 1,
        })
      ).claims,
    ).toEqual([]);

    // The window ages out.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("userQuotas").first();
      if (row) {
        await ctx.db.patch(row._id, {
          windowStart: Date.now() - 2 * 60 * 60 * 1000,
        });
      }
    });
    const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 5,
      maxPerUser: 1,
    });
    expect(claims).toHaveLength(1);
    await drain(t);
  });

  test("a claimed run consumes exactly one unit of the window", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    await u.mutation(api.scheduled.tasks.runNow, { taskId });
    await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 5,
      maxPerUser: 1,
    });
    const row = await t.run(async (ctx) => ctx.db.query("userQuotas").first());
    expect(row?.windowCount).toBe(1);
    await drain(t);
  });

  test("the interactive chat window is untouched by scheduled work", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    await u.mutation(api.scheduled.tasks.runNow, { taskId });
    await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 5,
      maxPerUser: 1,
    });
    const row = await t.run(async (ctx) => ctx.db.query("userQuotas").first());
    expect(row?.windowCount).toBe(1);
    // The two budgets are separate on purpose: unattended work must not spend a
    // user's interactive allowance.
    const chatRow = await quotaRow(t, userId, "chat");
    expect(chatRow?.windowCount ?? 0).toBe(0);
    await drain(t);
  });

  test("an exhausted SCHEDULED window does not block interactive chat", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws, u } = await seed(t);
    await exhaustWindow(t, userId, ws);
    const threadId = await u.mutation(api.chat.threads.create, {
      workspaceId: ws,
    });
    // Would throw "Hourly message limit reached" if the windows were shared.
    await expect(
      u.mutation(api.chat.messages.send, {
        threadId,
        content: "hello",
        clientId: "c1",
      }),
    ).resolves.toBeDefined();
    await drain(t);
  });

  test("one user's exhausted window does not stall another's task", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t);
    const b = await seed(t);
    await exhaustWindow(t, a.userId, a.ws);
    const ta = await mkTask(t, a.userId, a.ws);
    const tb = await mkTask(t, b.userId, b.ws);
    await a.u.mutation(api.scheduled.tasks.runNow, { taskId: ta });
    await b.u.mutation(api.scheduled.tasks.runNow, { taskId: tb });

    const { claims } = await t.mutation(internal.scheduled.occurrences.claim, {
      limit: 5,
      maxPerUser: 1,
    });
    expect(claims).toHaveLength(1);
    expect(claims[0].taskId).toBe(tb);
    await drain(t);
  });
});

// ---------------------------------------------------------------------------
// The provider webhook. The signature IS the authentication here.
// ---------------------------------------------------------------------------
describe("mail provider webhook", () => {
  const SECRET_RAW = "c3VwZXJzZWNyZXR2YWx1ZTEyMzQ1Ng==";

  async function sign(id: string, ts: string, body: string) {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(SECRET_RAW), (c) => c.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${ts}.${body}`),
    );
    return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
  }

  const post = (t: TestT, headers: Record<string, string>, body: string) =>
    t.fetch("/mail/webhook", { method: "POST", headers, body });

  test("an unconfigured secret closes the endpoint rather than opening it", async () => {
    const t = convexTest(schema, modules);
    unsetEnv("SCHEDULED_EMAIL_WEBHOOK_SECRET");
    const res = await post(t, {}, "{}");
    expect(res.status).toBe(404);
  });

  test("an unsigned request is rejected", async () => {
    const t = convexTest(schema, modules);
    process.env.SCHEDULED_EMAIL_WEBHOOK_SECRET = `whsec_${SECRET_RAW}`;
    const res = await post(t, {}, "{}");
    expect(res.status).toBe(401);
    unsetEnv("SCHEDULED_EMAIL_WEBHOOK_SECRET");
  });

  test("a forged signature is rejected", async () => {
    const t = convexTest(schema, modules);
    process.env.SCHEDULED_EMAIL_WEBHOOK_SECRET = `whsec_${SECRET_RAW}`;
    const res = await post(
      t,
      {
        "svix-id": "msg_1",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
      "{}",
    );
    expect(res.status).toBe(401);
    unsetEnv("SCHEDULED_EMAIL_WEBHOOK_SECRET");
  });

  test("a correctly signed but STALE request is rejected (replay window)", async () => {
    const t = convexTest(schema, modules);
    process.env.SCHEDULED_EMAIL_WEBHOOK_SECRET = `whsec_${SECRET_RAW}`;
    const body = JSON.stringify({ type: "email.delivered", data: {} });
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await post(
      t,
      {
        "svix-id": "msg_1",
        "svix-timestamp": old,
        "svix-signature": await sign("msg_1", old, body),
      },
      body,
    );
    expect(res.status).toBe(401);
    unsetEnv("SCHEDULED_EMAIL_WEBHOOK_SECRET");
  });

  test("a valid event is accepted and applied", async () => {
    const t = convexTest(schema, modules);
    process.env.SCHEDULED_EMAIL_WEBHOOK_SECRET = `whsec_${SECRET_RAW}`;
    const { userId, ws } = await seed(t);
    const taskId = await mkTask(t, userId, ws);
    await t.run(async (ctx) => {
      await ctx.db.insert("scheduledDeliveries", {
        occurrenceKey: "k1",
        taskId,
        userId,
        workspaceId: ws,
        channel: "email",
        status: "accepted",
        pdfStatus: "none",
        attachment: "none",
        wantEmail: true,
        wantPdf: false,
        outcome: "succeeded",
        idempotencyKey: "k1:email",
        providerMessageId: "eid_1",
        attempts: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const body = JSON.stringify({
      type: "email.delivered",
      data: { email_id: "eid_1" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await post(
      t,
      {
        "svix-id": "msg_2",
        "svix-timestamp": ts,
        "svix-signature": await sign("msg_2", ts, body),
      },
      body,
    );
    expect(res.status).toBe(200);
    const row = await t.run(async (ctx) =>
      ctx.db.query("scheduledDeliveries").first(),
    );
    expect(row?.status).toBe("delivered");
    unsetEnv("SCHEDULED_EMAIL_WEBHOOK_SECRET");
  });

  test("an unmodelled event is acknowledged, not retried forever", async () => {
    const t = convexTest(schema, modules);
    process.env.SCHEDULED_EMAIL_WEBHOOK_SECRET = `whsec_${SECRET_RAW}`;
    const body = JSON.stringify({
      type: "email.opened",
      data: { email_id: "eid_x" },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await post(
      t,
      {
        "svix-id": "msg_3",
        "svix-timestamp": ts,
        "svix-signature": await sign("msg_3", ts, body),
      },
      body,
    );
    // 200, so the provider stops resending something we will never act on.
    expect(res.status).toBe(200);
    unsetEnv("SCHEDULED_EMAIL_WEBHOOK_SECRET");
  });
});
