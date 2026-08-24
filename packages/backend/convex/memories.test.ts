/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { loadMemoriesForDispatch } from "./memories";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const member = await ctx.db.insert("users", { email: "member@t.test" });
    const outsider = await ctx.db.insert("users", { email: "out@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    const ws2 = await ctx.db.insert("workspaces", {
      name: "WS2",
      ownerId: owner,
      createdAt: Date.now(),
    });
    for (const [userId, workspaceId] of [
      [owner, ws],
      [member, ws],
      [owner, ws2],
    ] as const) {
      await ctx.db.insert("members", {
        workspaceId,
        userId,
        role: "member",
        createdAt: Date.now(),
      });
    }
    return { owner, member, outsider, ws, ws2 };
  });
}

async function insertMemory(
  t: ReturnType<typeof convexTest>,
  m: {
    userId: Id<"users">;
    workspaceId: Id<"workspaces">;
    kind?: string;
    content: string;
    scope?: "user" | "workspace";
    status?: "active" | "disabled" | "superseded";
  },
): Promise<Id<"userMemories">> {
  return t.run(async (ctx) =>
    ctx.db.insert("userMemories", {
      userId: m.userId,
      workspaceId: m.workspaceId,
      kind: (m.kind ?? "fact") as "fact",
      content: m.content,
      source: "explicit",
      scope: m.scope ?? "user",
      status: m.status ?? "active",
      normalizedKey: m.content.toLowerCase().trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

// A stream row Python's `remember` op is scoped by. `running` = live turn.
async function seedStream(
  t: ReturnType<typeof convexTest>,
  s: {
    userId: Id<"users">;
    workspaceId: Id<"workspaces">;
    status?: "running" | "done";
    streamId?: string;
  },
) {
  return t.run(async (ctx) => {
    const threadId = await ctx.db.insert("chatThreads", {
      userId: s.userId,
      workspaceId: s.workspaceId,
      title: "t",
      titleSource: "user",
      status: "active",
      pinned: false,
      model: "m",
      nextSeq: 2,
      messageCount: 1,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const messageId = await ctx.db.insert("chatMessages", {
      threadId,
      userId: s.userId,
      workspaceId: s.workspaceId,
      role: "assistant",
      content: "",
      seq: 1,
      status: "streaming",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const streamId = s.streamId ?? `stream_${Math.random()}`;
    await ctx.db.insert("chatStreams", {
      streamId,
      messageId,
      threadId,
      workspaceId: s.workspaceId,
      userId: s.userId,
      status: s.status ?? "running",
      cancelRequested: false,
      chunkSeq: 0,
      committedText: "",
      committedSeq: 0,
      heartbeatAt: Date.now(),
      startedAt: Date.now(),
    });
    return { streamId, threadId, messageId };
  });
}

function countMemories(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => (await ctx.db.query("userMemories").collect()).length);
}

// ---------------------------------------------------------------------------
// Private-per-user CRUD isolation (the headline property).
// ---------------------------------------------------------------------------
describe("userMemories are private per user", () => {
  test("a peer cannot remove or read another user's memory", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seed(t);
    const id = await insertMemory(t, {
      userId: owner,
      workspaceId: ws,
      content: "owner secret pref",
    });
    const peer = t.withIdentity(as(member));
    // Not found for a not-yours id — same as a missing one (no oracle).
    await expect(peer.mutation(api.memories.remove, { memoryId: id })).rejects.toThrow();
    await expect(
      peer.mutation(api.memories.update, { memoryId: id, content: "x" }),
    ).rejects.toThrow();
    // The peer's own list never contains the owner's memory.
    const page = await peer.query(api.memories.list, {
      workspaceId: ws,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(page.page).toHaveLength(0);
    // The row still exists (peer's remove did nothing).
    expect(await countMemories(t)).toBe(1);
  });

  test("owner CRUD round-trip; list strips normalizedKey", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await insertMemory(t, {
      userId: owner,
      workspaceId: ws,
      content: "Prefers concise",
    });
    const u = t.withIdentity(as(owner));
    const page = await u.query(api.memories.list, {
      workspaceId: ws,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(page.page).toHaveLength(1);
    expect(JSON.stringify(page.page)).not.toContain("normalizedKey");
    await u.mutation(api.memories.update, { memoryId: id, content: "Prefers terse" });
    await u.mutation(api.memories.setDisabled, { memoryId: id, disabled: true });
    await u.mutation(api.memories.remove, { memoryId: id });
    expect(await countMemories(t)).toBe(0);
  });

  test("clearAll removes only the caller's memories", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seed(t);
    await insertMemory(t, { userId: owner, workspaceId: ws, content: "o1" });
    await insertMemory(t, { userId: owner, workspaceId: ws, content: "o2" });
    await insertMemory(t, { userId: member, workspaceId: ws, content: "m1" });
    await t.withIdentity(as(owner)).mutation(api.memories.clearAll, { workspaceId: ws });
    const rows = await t.run(async (ctx) => ctx.db.query("userMemories").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(member);
  });
});

// ---------------------------------------------------------------------------
// Workspace-scope isolation — UNIT-TESTABLE here (plain index, not a search
// index), the concrete advantage of the chosen retrieval design.
// ---------------------------------------------------------------------------
describe("scope isolation in loadMemoriesForDispatch", () => {
  test("workspace memory does not cross workspaces; user memory spans them", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws, ws2 } = await seed(t);
    await insertMemory(t, {
      userId: owner,
      workspaceId: ws,
      content: "ws-A fact",
      scope: "workspace",
    });
    await insertMemory(t, {
      userId: owner,
      workspaceId: ws,
      content: "global pref",
      scope: "user",
    });

    const inA = await t.run((ctx) => loadMemoriesForDispatch(ctx, owner, ws));
    const inB = await t.run((ctx) => loadMemoriesForDispatch(ctx, owner, ws2));
    const contentsA = inA.map((m) => m.content);
    const contentsB = inB.map((m) => m.content);

    expect(contentsA).toContain("ws-A fact"); // ws memory present in its ws
    expect(contentsA).toContain("global pref");
    expect(contentsB).not.toContain("ws-A fact"); // NEVER leaks to ws-B
    expect(contentsB).toContain("global pref"); // user memory spans workspaces
  });
});

// ---------------------------------------------------------------------------
// The remember write path (Python -> /ai/ingress -> rememberFromIngress).
// ---------------------------------------------------------------------------
describe("rememberFromIngress capability + validation", () => {
  test("unknown streamId writes nothing", async () => {
    const t = convexTest(schema, modules);
    const r = await t.mutation(internal.memories.rememberFromIngress, {
      streamId: "does-not-exist",
      content: "hi",
      kind: "fact",
    });
    expect(r).toMatchObject({ unknown: true });
    expect(await countMemories(t)).toBe(0);
  });

  test("memory is owned by the stream's user (derived server-side)", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { streamId } = await seedStream(t, { userId: owner, workspaceId: ws });
    const r = await t.mutation(internal.memories.rememberFromIngress, {
      streamId,
      content: "I use Rust",
      kind: "fact",
    });
    expect(r).toMatchObject({ ok: true });
    const rows = await t.run((ctx) => ctx.db.query("userMemories").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(owner); // ownership from the stream, not args
    expect(rows[0].scope).toBe("workspace"); // fact defaults to workspace scope
  });

  test("terminal stream drops the write", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { streamId } = await seedStream(t, {
      userId: owner,
      workspaceId: ws,
      status: "done",
    });
    const r = await t.mutation(internal.memories.rememberFromIngress, {
      streamId,
      content: "late write",
      kind: "fact",
    });
    expect(r).toMatchObject({ dropped: "terminal" });
    expect(await countMemories(t)).toBe(0);
  });

  test("secret content is rejected", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { streamId } = await seedStream(t, { userId: owner, workspaceId: ws });
    const r = await t.mutation(internal.memories.rememberFromIngress, {
      streamId,
      content: "my key is sk-abcdefghijklmnop1234567890",
      kind: "fact",
    });
    expect(r).toMatchObject({ rejected: "secret" });
    expect(await countMemories(t)).toBe(0);
  });

  test("a bare secret-like word is NOT rejected", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { streamId } = await seedStream(t, { userId: owner, workspaceId: ws });
    const r = await t.mutation(internal.memories.rememberFromIngress, {
      streamId,
      content: "I always forget my password",
      kind: "fact",
    });
    expect(r).toMatchObject({ ok: true });
    expect(await countMemories(t)).toBe(1);
  });

  test("memoryEnabled=false is a no-op", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("chatSettings", {
        userId: owner,
        workspaceId: ws,
        defaultModel: "m",
        sendOnEnter: true,
        memoryEnabled: false,
        updatedAt: Date.now(),
      }),
    );
    const { streamId } = await seedStream(t, { userId: owner, workspaceId: ws });
    const r = await t.mutation(internal.memories.rememberFromIngress, {
      streamId,
      content: "should not save",
      kind: "fact",
    });
    expect(r).toMatchObject({ disabled: true });
    expect(await countMemories(t)).toBe(0);
  });

  test("identical content dedups to one row", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const { streamId } = await seedStream(t, { userId: owner, workspaceId: ws });
    await t.mutation(internal.memories.rememberFromIngress, {
      streamId,
      content: "I use Rust.",
      kind: "fact",
    });
    const r2 = await t.mutation(internal.memories.rememberFromIngress, {
      streamId,
      content: "i use rust",
      kind: "fact",
    });
    expect(r2).toMatchObject({ deduped: true });
    expect(await countMemories(t)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The forget path (Python -> /ai/ingress -> forgetFromIngress). DISABLES
// (reversible), own-user only, never hard-deletes or crosses users.
// ---------------------------------------------------------------------------
describe("forgetFromIngress capability + ownership", () => {
  test("disables the caller's own active memory (reversible, not deleted)", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await insertMemory(t, {
      userId: owner,
      workspaceId: ws,
      content: "favorite color is teal",
    });
    const { streamId } = await seedStream(t, { userId: owner, workspaceId: ws });
    const r = await t.mutation(internal.memories.forgetFromIngress, {
      streamId,
      memoryIds: [id],
    });
    expect(r).toMatchObject({ ok: true, disabled: 1 });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("disabled"); // disabled, NOT deleted
    expect(await countMemories(t)).toBe(1); // row still present (recoverable)
  });

  test("cannot disable another user's memory", async () => {
    const t = convexTest(schema, modules);
    const { owner, member, ws } = await seed(t);
    const victim = await insertMemory(t, {
      userId: member,
      workspaceId: ws,
      content: "member's private memory",
    });
    const { streamId } = await seedStream(t, { userId: owner, workspaceId: ws });
    const r = await t.mutation(internal.memories.forgetFromIngress, {
      streamId,
      memoryIds: [victim],
    });
    expect(r).toMatchObject({ ok: true, disabled: 0 }); // skipped, cross-user
    const row = await t.run((ctx) => ctx.db.get(victim));
    expect(row?.status).toBe("active"); // untouched
  });

  test("unknown streamId disables nothing", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await insertMemory(t, {
      userId: owner,
      workspaceId: ws,
      content: "x",
    });
    const r = await t.mutation(internal.memories.forgetFromIngress, {
      streamId: "nope",
      memoryIds: [id],
    });
    expect(r).toMatchObject({ unknown: true });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.status).toBe("active");
  });

  test("already-inactive rows are skipped (disabled count 0)", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const id = await insertMemory(t, {
      userId: owner,
      workspaceId: ws,
      content: "already off",
      status: "disabled",
    });
    const { streamId } = await seedStream(t, { userId: owner, workspaceId: ws });
    const r = await t.mutation(internal.memories.forgetFromIngress, {
      streamId,
      memoryIds: [id],
    });
    expect(r).toMatchObject({ ok: true, disabled: 0 });
  });
});
