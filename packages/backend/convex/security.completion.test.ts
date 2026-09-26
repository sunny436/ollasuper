/// <reference types="vite/client" />
/**
 * The residual items found when SECURITY-AUDIT-FINAL.md was re-audited against
 * the deployed remediation (2026-09-26): the paths the first pass missed, and
 * the retention gaps the report's Solution text asks for. Each block pairs the
 * failing case with a positive control.
 */
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
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
