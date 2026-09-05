/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Chat archive — the lifecycle, and the line between archive and delete.
 *
 * ARCHIVE IS NOT DELETE. Everything here exists to hold that line: an archived
 * thread keeps its id, its messages, its timestamps and its pin state, and comes
 * back byte-identical when restored. Delete stays destructive and separate.
 *
 * The backend was already complete before this feature — `threads.archive`, the
 * status-filtered `list`, and the Settings page all existed; only the menu item
 * that reaches them was missing. These tests pin the behaviour that was
 * previously unreachable, and therefore untested through a real user path.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

// messages.send schedules a dispatch that POSTs to the Python service. Same
// reasoning as chat.security.test.ts: make it "configured" and keep fetch off
// the network.
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
  process.env.AI_BASE_URL = undefined as unknown as string;
  process.env.AI_SERVICE_KEY = undefined as unknown as string;
});

async function drain(t: ReturnType<typeof convexTest>) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

type World = {
  owner: Id<"users">;
  other: Id<"users">;
  ws: Id<"workspaces">;
  otherWs: Id<"workspaces">;
};

async function seed(t: ReturnType<typeof convexTest>): Promise<World> {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const other = await ctx.db.insert("users", { email: "other@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    const otherWs = await ctx.db.insert("workspaces", {
      name: "OTHER",
      ownerId: other,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId: owner,
      role: "owner",
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: otherWs,
      userId: other,
      role: "owner",
      createdAt: Date.now(),
    });
    return { owner, other, ws, otherWs };
  });
}

/** A thread with one real user message, created through the public API. */
async function threadWithMessage(
  t: ReturnType<typeof convexTest>,
  w: World,
  title = "planning the trip",
  content = "how do I get to the airport",
) {
  const u = t.withIdentity(as(w.owner));
  const threadId = await u.mutation(api.chat.threads.create, {
    workspaceId: w.ws,
    title,
  });
  await u.mutation(api.chat.messages.send, {
    threadId,
    content,
    clientId: `c-${Math.random()}`,
  });
  await drain(t);
  await settleStream(t, threadId);
  return threadId;
}

/**
 * Mark the in-flight turn finished.
 *
 * `messages.send` sets `streamingMessageId` and the real dispatch clears it on
 * finalize — but dispatch is stubbed here, so without this a second send hits
 * "This conversation is already generating a reply" (the deliberate concurrent-
 * turn guard) rather than exercising what the test is about.
 */
const settleStream = (t: ReturnType<typeof convexTest>, threadId: Id<"chatThreads">) =>
  t.run(async (ctx) => {
    await ctx.db.patch(threadId, { streamingMessageId: undefined });
  });

const listActive = (t: ReturnType<typeof convexTest>, w: World) =>
  t.withIdentity(as(w.owner)).query(api.chat.threads.list, {
    workspaceId: w.ws,
    paginationOpts: { numItems: 50, cursor: null },
  });

const listArchived = (t: ReturnType<typeof convexTest>, w: World) =>
  t.withIdentity(as(w.owner)).query(api.chat.threads.list, {
    workspaceId: w.ws,
    status: "archived" as const,
    paginationOpts: { numItems: 50, cursor: null },
  });

const ids = (page: { page: Array<{ _id: unknown }> }) =>
  page.page.map((r) => r._id);

// ---------------------------------------------------------------------------
describe("archive lifecycle", () => {
  test("archiving moves a thread out of active and into archived", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);

    expect(ids(await listActive(t, w))).toContain(threadId);

    await t
      .withIdentity(as(w.owner))
      .mutation(api.chat.threads.archive, { threadId, archived: true });

    expect(ids(await listActive(t, w))).not.toContain(threadId);
    expect(ids(await listArchived(t, w))).toContain(threadId);
  });

  test("archiving destroys nothing — id, messages and timestamps survive", async () => {
    // THE distinction this whole feature rests on. Archive is a state change,
    // not data loss.
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);

    const before = await t.run(async (ctx) => {
      const thread = await ctx.db.get(threadId);
      const msgs = await ctx.db
        .query("chatMessages")
        .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
        .collect();
      return {
        title: thread?.title,
        createdAt: thread?.createdAt,
        msgs: msgs.map((m) => ({ id: m._id, seq: m.seq, content: m.content })),
      };
    });
    expect(before.msgs.length).toBeGreaterThan(0);

    await t
      .withIdentity(as(w.owner))
      .mutation(api.chat.threads.archive, { threadId, archived: true });

    const after = await t.run(async (ctx) => {
      const thread = await ctx.db.get(threadId);
      const msgs = await ctx.db
        .query("chatMessages")
        .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
        .collect();
      return {
        title: thread?.title,
        createdAt: thread?.createdAt,
        status: thread?.status,
        msgs: msgs.map((m) => ({ id: m._id, seq: m.seq, content: m.content })),
      };
    });

    expect(after.status).toBe("archived");
    expect(after.title).toBe(before.title);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.msgs).toEqual(before.msgs); // ids, order and content identical
  });

  test("unarchiving returns the SAME thread to active history", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);
    const u = t.withIdentity(as(w.owner));

    await u.mutation(api.chat.threads.archive, { threadId, archived: true });
    await u.mutation(api.chat.threads.archive, { threadId, archived: false });

    expect(ids(await listActive(t, w))).toContain(threadId);
    expect(ids(await listArchived(t, w))).not.toContain(threadId);
    expect(await t.run(async (ctx) => (await ctx.db.get(threadId))?.status)).toBe(
      "active",
    );
  });

  test("an archived thread can still be opened", async () => {
    // Opening must not silently unarchive it, either.
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);
    const u = t.withIdentity(as(w.owner));
    await u.mutation(api.chat.threads.archive, { threadId, archived: true });

    const got = await u.query(api.chat.threads.get, { threadId });
    expect(got).not.toBeNull();
    expect(await t.run(async (ctx) => (await ctx.db.get(threadId))?.status)).toBe(
      "archived",
    );
  });

  test("sending a message leaves an archived thread archived", async () => {
    // The deliberate product rule: archive means "out of my sidebar" until the
    // user says otherwise. Nothing in the send path may quietly reactivate it.
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);
    const u = t.withIdentity(as(w.owner));
    await u.mutation(api.chat.threads.archive, { threadId, archived: true });

    await u.mutation(api.chat.messages.send, {
      threadId,
      content: "one more thing",
      clientId: `c-${Math.random()}`,
    });
    await drain(t);

    expect(await t.run(async (ctx) => (await ctx.db.get(threadId))?.status)).toBe(
      "archived",
    );
    expect(ids(await listActive(t, w))).not.toContain(threadId);
  });
});

// ---------------------------------------------------------------------------
describe("archive is not delete", () => {
  test("an archived thread can still be deleted", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);
    const u = t.withIdentity(as(w.owner));

    await u.mutation(api.chat.threads.archive, { threadId, archived: true });
    await u.mutation(api.chat.threads.remove, { threadId });
    await drain(t);

    expect(ids(await listArchived(t, w))).not.toContain(threadId);
    expect(ids(await listActive(t, w))).not.toContain(threadId);
  });

  test("archive does not trash, and delete does not merely unarchive", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const archived = await threadWithMessage(t, w, "to archive");
    const deleted = await threadWithMessage(t, w, "to delete");
    const u = t.withIdentity(as(w.owner));

    await u.mutation(api.chat.threads.archive, {
      threadId: archived,
      archived: true,
    });
    await u.mutation(api.chat.threads.remove, { threadId: deleted });
    await drain(t);

    const states = await t.run(async (ctx) => ({
      archived: (await ctx.db.get(archived))?.status,
      deleted: (await ctx.db.get(deleted))?.status ?? "purged",
    }));
    expect(states.archived).toBe("archived");
    expect(states.deleted).not.toBe("archived");
    expect(states.deleted).not.toBe("active");
  });
});

// ---------------------------------------------------------------------------
describe("authorization", () => {
  test("a non-owner cannot archive someone else's thread", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);

    await expect(
      t
        .withIdentity(as(w.other))
        .mutation(api.chat.threads.archive, { threadId, archived: true }),
    ).rejects.toThrow();

    expect(await t.run(async (ctx) => (await ctx.db.get(threadId))?.status)).toBe(
      "active",
    );
  });

  test("a non-owner cannot unarchive someone else's thread", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);
    await t
      .withIdentity(as(w.owner))
      .mutation(api.chat.threads.archive, { threadId, archived: true });

    await expect(
      t
        .withIdentity(as(w.other))
        .mutation(api.chat.threads.archive, { threadId, archived: false }),
    ).rejects.toThrow();

    expect(await t.run(async (ctx) => (await ctx.db.get(threadId))?.status)).toBe(
      "archived",
    );
  });

  test("archived lists are per-user, not per-workspace", async () => {
    // Chat is user-scoped even inside a shared workspace: a workspace member
    // must not see another member's archived conversations.
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);
    await t
      .withIdentity(as(w.owner))
      .mutation(api.chat.threads.archive, { threadId, archived: true });

    await t.run(async (ctx) => {
      await ctx.db.insert("members", {
        workspaceId: w.ws,
        userId: w.other,
        role: "member",
        createdAt: Date.now(),
      });
    });

    const theirs = await t.withIdentity(as(w.other)).query(api.chat.threads.list, {
      workspaceId: w.ws,
      status: "archived" as const,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(ids(theirs)).not.toContain(threadId);
  });

  test("an anonymous caller sees no archived threads", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);
    await t
      .withIdentity(as(w.owner))
      .mutation(api.chat.threads.archive, { threadId, archived: true });

    const anon = await t.query(api.chat.threads.list, {
      workspaceId: w.ws,
      status: "archived" as const,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(ids(anon)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("idempotency", () => {
  test("archiving twice is safe", async () => {
    // A double-click, a retry, two tabs. Repeats must converge, not corrupt.
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);
    const u = t.withIdentity(as(w.owner));

    await u.mutation(api.chat.threads.archive, { threadId, archived: true });
    await u.mutation(api.chat.threads.archive, { threadId, archived: true });
    await u.mutation(api.chat.threads.archive, { threadId, archived: true });

    const archivedIds = ids(await listArchived(t, w));
    expect(archivedIds.filter((id) => id === threadId)).toHaveLength(1);
    expect(await t.run(async (ctx) => (await ctx.db.get(threadId))?.status)).toBe(
      "archived",
    );
  });

  test("unarchiving an already-active thread is safe", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);
    const u = t.withIdentity(as(w.owner));

    await u.mutation(api.chat.threads.archive, { threadId, archived: false });
    await u.mutation(api.chat.threads.archive, { threadId, archived: false });

    const activeIds = ids(await listActive(t, w));
    expect(activeIds.filter((id) => id === threadId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("pin interaction", () => {
  test("an archived pinned thread leaves the pinned rail but KEEPS its pin", async () => {
    // User intent is preserved: unarchiving restores it to the pinned section
    // rather than silently demoting it.
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(t, w);
    const u = t.withIdentity(as(w.owner));

    await u.mutation(api.chat.threads.setPinned, { threadId, pinned: true });
    expect(
      (await u.query(api.chat.threads.listPinned, { workspaceId: w.ws })).map(
        (r) => r._id,
      ),
    ).toContain(threadId);

    await u.mutation(api.chat.threads.archive, { threadId, archived: true });

    const pinnedWhileArchived = await u.query(api.chat.threads.listPinned, {
      workspaceId: w.ws,
    });
    expect(pinnedWhileArchived.map((r) => r._id)).not.toContain(threadId);
    expect(await t.run(async (ctx) => (await ctx.db.get(threadId))?.pinned)).toBe(
      true,
    );

    await u.mutation(api.chat.threads.archive, { threadId, archived: false });
    expect(
      (await u.query(api.chat.threads.listPinned, { workspaceId: w.ws })).map(
        (r) => r._id,
      ),
    ).toContain(threadId);
  });
});

// ---------------------------------------------------------------------------
describe("search", () => {
  test("an archived thread is absent from BOTH title and message search", async () => {
    // The inconsistency this feature had to fix: title search already pinned
    // status "active", while the message-content pass skipped only "trashed" —
    // so the same conversation was findable by its message text and not by its
    // title.
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(
      t,
      w,
      "zeppelin planning",
      "the zeppelin departs at dawn",
    );
    const u = t.withIdentity(as(w.owner));

    // Findable while active, on both paths.
    expect(
      (await u.query(api.chat.search.threads, {
        workspaceId: w.ws,
        query: "zeppelin",
      })).length,
    ).toBeGreaterThan(0);
    const msgHitsActive = await u.query(api.chat.search.messages, {
      workspaceId: w.ws,
      query: "zeppelin",
    });
    expect(msgHitsActive.length).toBeGreaterThan(0);

    await u.mutation(api.chat.threads.archive, { threadId, archived: true });

    expect(
      await u.query(api.chat.search.threads, {
        workspaceId: w.ws,
        query: "zeppelin",
      }),
    ).toHaveLength(0);
    expect(
      await u.query(api.chat.search.messages, {
        workspaceId: w.ws,
        query: "zeppelin",
      }),
    ).toHaveLength(0);
  });

  test("unarchiving makes it findable again", async () => {
    const t = convexTest(schema, modules);
    const w = await seed(t);
    const threadId = await threadWithMessage(
      t,
      w,
      "zeppelin planning",
      "the zeppelin departs at dawn",
    );
    const u = t.withIdentity(as(w.owner));

    await u.mutation(api.chat.threads.archive, { threadId, archived: true });
    await u.mutation(api.chat.threads.archive, { threadId, archived: false });

    expect(
      (await u.query(api.chat.search.threads, {
        workspaceId: w.ws,
        query: "zeppelin",
      })).length,
    ).toBeGreaterThan(0);
  });
});
