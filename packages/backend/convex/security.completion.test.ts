/// <reference types="vite/client" />
/**
 * The residual items found when SECURITY-AUDIT-FINAL.md was re-audited against
 * the deployed remediation (2026-09-26): the paths the first pass missed, and
 * the retention gaps the report's Solution text asks for. Each block pairs the
 * failing case with a positive control.
 */
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
type TestT = TestConvex<typeof schema>;
const DAY = 24 * 60 * 60 * 1000;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_SERVICE_KEY;
});

async function seedUser(t: TestT, email = "u@t.test") {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
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
}

const blobExists = (t: TestT, id: Id<"_storage">) =>
  t.run(async (ctx) => (await ctx.db.system.get(id)) !== null);

/** An avatar upload as the client makes it: URL (records the intent), bytes. */
async function uploadAvatar(t: TestT, userId: Id<"users">) {
  await t.withIdentity(as(userId)).mutation(api.users.generateUploadUrl, {});
  return t.run((ctx) =>
    ctx.storage.store(new Blob(["png-bytes"], { type: "image/png" })),
  );
}

describe("F-05: the capability lists honour session revocation", () => {
  test("a revoked session reads null and never reaches the AI plane", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedUser(t);
    process.env.AI_BASE_URL = "http://ai.invalid:8000";
    process.env.AI_SERVICE_KEY = "k";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          enabled: ["seo"],
          capabilities: [{ id: "page.fetch", group: "web" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const caller = t.withIdentity(as(userId));

    // Positive control: a live session reads both lists.
    expect(await caller.action(api.chat.capabilities.list, {})).toEqual(["seo"]);
    expect(await caller.action(api.skillCapabilities.list, {})).toEqual([
      { id: "page.fetch", group: "web" },
    ]);
    expect(calls).toBe(2);

    // Sign-out / displacement deletes the session; the JWT is still "valid".
    await t.run(async (ctx) => {
      for (const s of await ctx.db.query("authSessions").collect()) {
        await ctx.db.delete(s._id);
      }
    });
    expect(await caller.action(api.chat.capabilities.list, {})).toBeNull();
    expect(await caller.action(api.skillCapabilities.list, {})).toBeNull();
    expect(calls).toBe(2); // the service key was never spent for it
  });
});

describe("avatar: a replaced or reset photo does not stay stored", () => {
  test("replace deletes the previous blob; reset deletes the current one", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seedUser(t);
    const me = t.withIdentity(as(userId));

    const first = await uploadAvatar(t, userId);
    await me.mutation(api.users.updateUserImage, { imageId: first });
    const second = await uploadAvatar(t, userId);
    await me.mutation(api.users.updateUserImage, { imageId: second });
    expect(await blobExists(t, first)).toBe(false);
    expect(await blobExists(t, second)).toBe(true); // positive control

    await me.mutation(api.users.removeUserImage, {});
    expect(await blobExists(t, second)).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(userId));
    expect(row?.imageId).toBeUndefined();
  });
});

describe("F-12: blob deletion never strands bytes and tolerates missing ones", () => {
  test("a row whose blob is already gone is still deletable", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t);
    await t
      .withIdentity(as(userId))
      .mutation(api.files.generateUploadUrl, { workspaceId: ws });
    const sid = await t.run((ctx) =>
      ctx.storage.store(new Blob(["x"], { type: "text/plain" })),
    );
    const fileId = await t.withIdentity(as(userId)).mutation(api.files.saveFile, {
      workspaceId: ws,
      storageId: sid,
      name: "x.txt",
      size: 1,
      contentType: "text/plain",
    });
    await t.run((ctx) => ctx.storage.delete(sid)); // bytes lost out of band
    await t.withIdentity(as(userId)).mutation(api.files.remove, { fileId });
    expect(await t.run((ctx) => ctx.db.get(fileId))).toBeNull();
  });

  test("reconcileOrphanBlobs finds only old, unreferenced, unshared bytes", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t);
    const store = (body: string) =>
      t.run((ctx) => ctx.storage.store(new Blob([body], { type: "text/plain" })));
    const orphan = await store("orphan");
    const referenced = await store("referenced");
    const shared = await store("shared");
    await t.run(async (ctx) => {
      await ctx.db.patch(userId, { imageId: referenced });
      const threadId = await ctx.db.insert("chatThreads", {
        userId,
        workspaceId: ws,
        title: "t",
        titleSource: "user",
        status: "active",
        pinned: false,
        model: "m",
        nextSeq: 0,
        messageCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        lastMessageAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("chatShares", {
        token: "tok",
        userId,
        workspaceId: ws,
        chatId: threadId,
        shareType: "full_chat",
        title: "t",
        snapshot: JSON.stringify({
          messages: [{ attachments: [{ storageId: shared, name: "a" }] }],
        }),
        createdAt: Date.now(),
        expiresAt: Date.now() + 7 * DAY,
      });
    });

    // Fresh bytes are never candidates (an upload may still be registering).
    const fresh = await t.mutation(internal.authDeletion.reconcileOrphanBlobs, {});
    expect(fresh.orphans).toEqual([]);

    // Treat everything as old enough: only the true orphan is listed.
    const dry = await t.mutation(internal.authDeletion.reconcileOrphanBlobs, {
      minAgeMs: 0,
    });
    expect(dry.orphans.map((o) => o.storageId)).toEqual([orphan]);
    expect(await blobExists(t, orphan)).toBe(true); // dry run by default

    await t.mutation(internal.authDeletion.reconcileOrphanBlobs, {
      minAgeMs: 0,
      apply: true,
    });
    expect(await blobExists(t, orphan)).toBe(false);
    expect(await blobExists(t, referenced)).toBe(true);
    expect(await blobExists(t, shared)).toBe(true);
  });
});

describe("automatic upload cleanup (crons: sweepUnsentAttachments, sweepOrphanBlobs)", () => {
  const store = (t: TestT, body: string) =>
    t.run((ctx) => ctx.storage.store(new Blob([body], { type: "text/plain" })));
  const attach = (
    t: TestT,
    userId: Id<"users">,
    ws: Id<"workspaces">,
    storageId: Id<"_storage">,
    extra: { createdAt: number; messageId?: Id<"chatMessages"> },
  ) =>
    t.run((ctx) =>
      ctx.db.insert("chatAttachments", {
        workspaceId: ws,
        userId,
        storageId,
        name: "a.txt",
        size: 1,
        contentType: "text/plain",
        kind: "text",
        status: "uploaded",
        ...extra,
      }),
    );

  test("an attachment unsent for a week goes with its blob; sent and recent ones stay", async () => {
    const t = convexTest(schema, modules);
    const { userId, ws } = await seedUser(t);
    const [oldSid, newSid, sentSid] = [
      await store(t, "old"),
      await store(t, "new"),
      await store(t, "sent"),
    ];
    const old = await attach(t, userId, ws, oldSid, { createdAt: Date.now() - 8 * DAY });
    const recent = await attach(t, userId, ws, newSid, { createdAt: Date.now() - DAY });
    const messageId = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("chatThreads", {
        userId,
        workspaceId: ws,
        title: "t",
        titleSource: "user",
        status: "active",
        pinned: false,
        model: "m",
        nextSeq: 1,
        messageCount: 1,
        tokensIn: 0,
        tokensOut: 0,
        lastMessageAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return ctx.db.insert("chatMessages", {
        threadId,
        workspaceId: ws,
        userId,
        role: "user",
        seq: 0,
        content: "hi",
        status: "complete",
        variantCount: 1,
        activeVariantIndex: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const sent = await attach(t, userId, ws, sentSid, {
      createdAt: Date.now() - 30 * DAY,
      messageId,
    });

    const r = await t.mutation(internal.authDeletion.sweepUnsentAttachments, {});
    expect(r).toEqual({ deleted: 1, stopped: false });
    expect(await t.run((ctx) => ctx.db.get(old))).toBeNull();
    expect(await blobExists(t, oldSid)).toBe(false);
    for (const [id, sid] of [
      [recent, newSid],
      [sent, sentSid],
    ] as const) {
      expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
      expect(await blobExists(t, sid)).toBe(true);
    }
  });

  test("the blob sweep deletes only unreferenced bytes and pages itself to the end", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const { userId, ws } = await seedUser(t);
      // More than one page (100) of orphans, so the sweep must continue itself.
      // The 100th blob is the referenced one: convex-test resumes a cursor by
      // finding its document again, so the page boundary must survive (real
      // Convex cursors are index positions and survive deletions anyway).
      const orphans: Id<"_storage">[] = [];
      for (let i = 0; i < 99; i++) orphans.push(await store(t, `o${i}`));
      const kept = await store(t, "kept");
      await attach(t, userId, ws, kept, { createdAt: Date.now() });
      for (let i = 99; i < 130; i++) orphans.push(await store(t, `o${i}`));

      // Fake timers freeze the clock; let the bytes be a second old.
      vi.setSystemTime(Date.now() + 1000);
      await t.mutation(internal.authDeletion.sweepOrphanBlobs, { minAgeMs: 0 });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(await blobExists(t, kept)).toBe(true);
      const left = await t.run(async (ctx) => ctx.db.system.query("_storage").collect());
      expect(left.map((b) => b._id)).toEqual([kept]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("young bytes are never swept, and a mass deletion trips the breaker instead", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const young = await store(t, "young");
      vi.setSystemTime(Date.now() + 1000);
      expect(await t.mutation(internal.authDeletion.sweepOrphanBlobs, {})).toEqual({
        deleted: 0,
        stopped: false,
      });
      expect(await blobExists(t, young)).toBe(true);

      const more = [await store(t, "a"), await store(t, "b")];
      vi.setSystemTime(Date.now() + 1000);
      const r = await t.mutation(internal.authDeletion.sweepOrphanBlobs, {
        minAgeMs: 0,
        maxDeletions: 2,
      });
      expect(r).toEqual({ deleted: 0, stopped: true });
      for (const sid of [young, ...more]) expect(await blobExists(t, sid)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("knowledge uploads queue behind the ingest limit instead of failing", () => {
  async function seedFile(t: TestT) {
    const { userId, ws } = await seedUser(t);
    return t.run((ctx) =>
      ctx.db.insert("userFiles", {
        userId,
        workspaceId: ws,
        name: "b.txt",
        size: 1,
        contentType: "text/plain",
        ingestId: "ing_1",
        status: "processing",
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now() - 60_000,
      }),
    );
  }
  const answer = (status: number) =>
    (async () =>
      new Response("{}", {
        status,
        headers: { "retry-after": "5" },
      })) as unknown as typeof fetch;

  test("a 429 keeps the file processing, marks it queued and re-schedules", async () => {
    const t = convexTest(schema, modules);
    process.env.AI_BASE_URL = "http://ai.invalid:8000";
    process.env.AI_SERVICE_KEY = "k";
    const fileId = await seedFile(t);
    globalThis.fetch = answer(429);

    await t.action(internal.userFiles.dispatch, { fileId });
    const row = await t.run((ctx) => ctx.db.get(fileId));
    expect(row?.status).toBe("processing");
    expect(row?.stage).toBe("queued");
    expect((row?.updatedAt ?? 0) > Date.now() - 5_000).toBe(true); // reaper-safe
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const retry = jobs.find((j) => j.name.includes("dispatch"));
    expect(retry?.args[0]).toMatchObject({ fileId, queued: 1 });
  });

  test("past the attempt cap it fails with a retryable message", async () => {
    const t = convexTest(schema, modules);
    process.env.AI_BASE_URL = "http://ai.invalid:8000";
    process.env.AI_SERVICE_KEY = "k";
    const fileId = await seedFile(t);
    globalThis.fetch = answer(429);

    await t.action(internal.userFiles.dispatch, { fileId, queued: 120 });
    const row = await t.run((ctx) => ctx.db.get(fileId));
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/busy/i);
  });

  test("an accepted dispatch changes nothing (positive control)", async () => {
    const t = convexTest(schema, modules);
    process.env.AI_BASE_URL = "http://ai.invalid:8000";
    process.env.AI_SERVICE_KEY = "k";
    const fileId = await seedFile(t);
    globalThis.fetch = answer(202);

    await t.action(internal.userFiles.dispatch, { fileId });
    const row = await t.run((ctx) => ctx.db.get(fileId));
    expect(row?.status).toBe("processing");
    expect(row?.stage).toBeUndefined();
  });
});

describe("F-13: a knowledge purge outlives an outage of the inference plane", () => {
  test("a failing purge keeps re-scheduling (capped hourly) far past five attempts", async () => {
    const t = convexTest(schema, modules);
    process.env.AI_BASE_URL = "http://ai.invalid:8000";
    process.env.AI_SERVICE_KEY = "k";
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await t.action(internal.userFiles.purge, { ingestId: "ing_x", attempt: 10 });
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const next = jobs.find((j) => j.name.includes("purge"));
    expect(next?.args[0]).toMatchObject({ ingestId: "ing_x", attempt: 11 });
    // Capped at an hour, not 30 s * 2^10 (~8.5 h).
    expect((next?.scheduledTime ?? 0) - Date.now()).toBeLessThanOrEqual(60 * 60_000 + 5_000);

    // The week-long horizon still ends.
    const t2 = convexTest(schema, modules);
    await t2.action(internal.userFiles.purge, { ingestId: "ing_y", attempt: 174 });
    const after = await t2.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(after.filter((j) => j.name.includes("purge"))).toHaveLength(0);
  });
});

describe("F-08 lifecycle: a member removed while viewing gets empty reads, not errors", () => {
  // The workspace-scoped RAIL queries keep denying non-members outright —
  // chat.security.test.ts pins that for outsiders, and a removed member IS
  // one. The owner-known thread reads below are the ones a page left open
  // re-runs, so they degrade to the not-found state instead of throwing.
  test("thread, transcript and events degrade to empty; a stranger still gets Not found", async () => {
    const t = convexTest(schema, modules);
    const { userId: owner, ws } = await seedUser(t, "owner@t.test");
    const { userId: stranger } = await seedUser(t, "stranger@t.test");
    const member = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { email: "member@t.test" });
      await ctx.db.insert("members", { workspaceId: ws, userId: id, role: "member", createdAt: Date.now() });
      return id;
    });
    const m = t.withIdentity(as(member));
    const threadId = await m.mutation(api.chat.threads.create, { workspaceId: ws, title: "mine" });
    const messageId = await t.run((ctx) =>
      ctx.db.insert("chatMessages", {
        threadId,
        userId: member,
        workspaceId: ws,
        role: "user",
        content: "hi",
        seq: 0,
        status: "complete",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const page = { numItems: 10, cursor: null };
    expect(await m.query(api.chat.threads.get, { threadId })).not.toBeNull(); // control

    // Removed while the page is open.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("members")
        .withIndex("by_user", (q) => q.eq("userId", member))
        .first();
      if (row) await ctx.db.delete(row._id);
    });
    expect(await m.query(api.chat.threads.get, { threadId })).toBeNull();
    expect((await m.query(api.chat.messages.listPaged, { threadId, paginationOpts: page })).page).toEqual([]);
    expect(await m.query(api.chat.stream.events, { messageId })).toBeNull();

    // A non-owner's answer is unchanged: Not found, no oracle.
    await expect(
      t.withIdentity(as(stranger)).query(api.chat.messages.listPaged, { threadId, paginationOpts: page }),
    ).rejects.toThrow(/Not found/);
    void owner;
  });
});
