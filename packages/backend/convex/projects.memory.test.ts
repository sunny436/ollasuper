/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

/**
 * PHASE 4 — Project memory.
 *
 * Project memory is real IDENTITY (scope + projectId), not the `project_context`
 * KIND that already existed — a kind is a label anyone can pick and is not a
 * security boundary.
 *
 * Two boundaries are defended here, and only one of them is caught by userId:
 *
 *  - cross-USER, which the existing checks already covered;
 *  - cross-PROJECT for the SAME user, which they did not. One person owns every
 *    one of their Projects, so `m.userId === stream.userId` is true across all
 *    of them. That is the gap this phase closes.
 */

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
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_BASE_URL;
  // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
  delete process.env.AI_SERVICE_KEY;
});

async function drain(t: ReturnType<typeof convexTest>) {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId,
      userId,
      role: "owner",
      createdAt: Date.now(),
    });
    return { userId, workspaceId };
  });
}

/** Start a real turn so there is a live streamId capability to write through. */
async function startTurn(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  projectId?: Id<"projects">,
) {
  const asUser = t.withIdentity(as(userId));
  const threadId = await asUser.mutation(api.chat.threads.create, {
    workspaceId,
    ...(projectId ? { projectId } : {}),
  });
  const sent = await asUser.mutation(api.chat.messages.send, {
    threadId,
    content: "remember something",
    clientId: `c-${threadId}`,
  });
  await drain(t);
  return { threadId, streamId: sent.streamId as string };
}

const remember = (
  t: ReturnType<typeof convexTest>,
  streamId: string,
  content: string,
  kind: "preference" | "instruction" | "fact" | "project_context" = "fact",
) =>
  t.mutation(internal.memories.rememberFromIngress, {
    streamId,
    content,
    kind,
  });

const rowsOf = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("userMemories").collect());

describe("project memory identity", () => {
  test("identical text in two projects stays two independent memories", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const a = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "A",
    });
    const b = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "B",
    });
    const ta = await startTurn(t, userId, workspaceId, a);
    const tb = await startTurn(t, userId, workspaceId, b);

    // The SAME sentence. Dedup keys on normalized content, so if the query did
    // not branch onto by_user_project_key these would collapse into one row and
    // silently merge two Projects' memories.
    await remember(t, ta.streamId, "The client prefers weekly updates.");
    await remember(t, tb.streamId, "The client prefers weekly updates.");

    const rows = await rowsOf(t);
    expect(rows).toHaveLength(2);
    expect(rows.every((m) => m.scope === "project")).toBe(true);
    expect(new Set(rows.map((m) => m.projectId))).toEqual(new Set([a, b]));
  });

  test("remembering twice in the SAME project still dedups", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const p = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });
    const turn = await startTurn(t, userId, workspaceId, p);

    await remember(t, turn.streamId, "Deploys happen on Thursdays.");
    const second = await remember(t, turn.streamId, "Deploys happen on Thursdays.");

    expect(second).toMatchObject({ deduped: true });
    expect(await rowsOf(t)).toHaveLength(1);
  });

  test("scope is derived from the thread and overrides defaultScopeForKind", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const p = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });
    const inProject = await startTurn(t, userId, workspaceId, p);
    const loose = await startTurn(t, userId, workspaceId);

    // `preference` would default to "user" and `fact` to "workspace"; inside a
    // Project the container wins for both, or a preference learned about one
    // client would follow the user into unrelated work.
    await remember(t, inProject.streamId, "Prefers bullet points.", "preference");
    await remember(t, loose.streamId, "Prefers long prose.", "preference");

    const rows = await rowsOf(t);
    const scoped = rows.find((m) => m.content === "Prefers bullet points.");
    const global = rows.find((m) => m.content === "Prefers long prose.");
    expect(scoped?.scope).toBe("project");
    expect(scoped?.projectId).toBe(p);
    expect(global?.scope).toBe("user");
    expect(global?.projectId).toBeUndefined();
  });
});

describe("project memory retrieval", () => {
  /** The pool Convex hands the inference plane for a turn. */
  const poolFor = (
    t: ReturnType<typeof convexTest>,
    userId: Id<"users">,
    workspaceId: Id<"workspaces">,
    projectId?: Id<"projects">,
  ) =>
    t.run(async (ctx) => {
      const { loadMemoriesForDispatch } = await import("./memories");
      return loadMemoriesForDispatch(ctx, userId, workspaceId, projectId);
    });

  test("an unassigned chat never receives project memory", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const p = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });
    const inProject = await startTurn(t, userId, workspaceId, p);
    await remember(t, inProject.streamId, "Project-only secret.");

    const pool = await poolFor(t, userId, workspaceId);
    expect(pool.map((m) => m.content)).not.toContain("Project-only secret.");
    expect(pool).toEqual([]);
  });

  test("project A memory never reaches project B", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const a = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "A",
    });
    const b = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "B",
    });
    const ta = await startTurn(t, userId, workspaceId, a);
    await remember(t, ta.streamId, "ALPHA secret.");

    expect((await poolFor(t, userId, workspaceId, a)).map((m) => m.content)).toEqual(
      ["ALPHA secret."],
    );
    expect(await poolFor(t, userId, workspaceId, b)).toEqual([]);
  });

  test("a project chat sees project + workspace + user, project first", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const p = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });

    // Seeded directly so the tiers have controlled, interleaved timestamps.
    await t.run(async (ctx) => {
      const base = Date.now();
      const mk = (
        content: string,
        scope: "user" | "workspace" | "project",
        updatedAt: number,
        projectId?: Id<"projects">,
      ) =>
        ctx.db.insert("userMemories", {
          userId,
          workspaceId,
          kind: "fact" as const,
          content,
          source: "explicit" as const,
          scope,
          ...(projectId ? { projectId } : {}),
          status: "active" as const,
          normalizedKey: content.toLowerCase(),
          createdAt: base,
          updatedAt,
        });
      // The project memory is the OLDEST, so a recency sort would rank it last.
      await mk("project fact", "project", base - 10_000, p);
      await mk("workspace fact", "workspace", base - 5_000);
      await mk("user fact", "user", base);
    });

    const pool = await poolFor(t, userId, workspaceId, p);
    expect(pool.map((m) => m.content)).toEqual([
      "project fact",
      "workspace fact",
      "user fact",
    ]);
  });

  test("project memory is not evicted from the pool by newer global memories", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const p = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });

    // 60 user-global memories, ALL newer than the project one. DISPATCH_CAP is
    // 40, so a concat-then-sort-by-recency merge would push the Project's own
    // memory out of its own conversation entirely.
    await t.run(async (ctx) => {
      const base = Date.now();
      await ctx.db.insert("userMemories", {
        userId,
        workspaceId,
        kind: "fact" as const,
        content: "the project fact",
        source: "explicit" as const,
        scope: "project" as const,
        projectId: p,
        status: "active" as const,
        normalizedKey: "the project fact",
        createdAt: base - 100_000,
        updatedAt: base - 100_000,
      });
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("userMemories", {
          userId,
          workspaceId,
          kind: "fact" as const,
          content: `global ${i}`,
          source: "explicit" as const,
          scope: "user" as const,
          status: "active" as const,
          normalizedKey: `global ${i}`,
          createdAt: base + i,
          updatedAt: base + i,
        });
      }
    });

    const pool = await poolFor(t, userId, workspaceId, p);
    expect(pool[0]?.content).toBe("the project fact");
    expect(pool).toHaveLength(40);
  });

  test("an ordinary chat's pool is unchanged by the project tier", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const loose = await startTurn(t, userId, workspaceId);
    await remember(t, loose.streamId, "A global fact.", "preference");

    const pool = await poolFor(t, userId, workspaceId);
    expect(pool.map((m) => m.content)).toEqual(["A global fact."]);
  });
});

describe("forget respects the project boundary", () => {
  test("a project A turn cannot forget a project B memory", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const a = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "A",
    });
    const b = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "B",
    });
    const ta = await startTurn(t, userId, workspaceId, a);
    const tb = await startTurn(t, userId, workspaceId, b);

    await remember(t, tb.streamId, "BETA private note.");
    const bMemory = (await rowsOf(t)).find((m) => m.projectId === b);
    expect(bMemory).toBeDefined();

    // The userId check alone passes here — one user owns both Projects. Only
    // the project comparison stops this.
    const res = await t.mutation(internal.memories.forgetFromIngress, {
      streamId: ta.streamId,
      memoryIds: [bMemory?._id as Id<"userMemories">],
    });
    expect(res).toMatchObject({ disabled: 0 });

    const after = await t.run(async (ctx) =>
      ctx.db.get(bMemory?._id as Id<"userMemories">),
    );
    expect(after?.status).toBe("active");
  });

  test("a project turn can forget its OWN memory", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const p = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });
    const turn = await startTurn(t, userId, workspaceId, p);
    await remember(t, turn.streamId, "Forget me.");
    const mem = (await rowsOf(t))[0];

    const res = await t.mutation(internal.memories.forgetFromIngress, {
      streamId: turn.streamId,
      memoryIds: [mem?._id as Id<"userMemories">],
    });
    expect(res).toMatchObject({ disabled: 1 });
  });

  test("an ordinary chat cannot forget a project memory", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const p = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });
    const inProject = await startTurn(t, userId, workspaceId, p);
    const loose = await startTurn(t, userId, workspaceId);
    await remember(t, inProject.streamId, "Project note.");
    const mem = (await rowsOf(t)).find((m) => m.projectId === p);

    const res = await t.mutation(internal.memories.forgetFromIngress, {
      streamId: loose.streamId,
      memoryIds: [mem?._id as Id<"userMemories">],
    });
    expect(res).toMatchObject({ disabled: 0 });
  });
});

describe("lifecycle and known behaviour", () => {
  test("moving a chat between projects does NOT move memory", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const a = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "A",
    });
    const b = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "B",
    });
    const turn = await startTurn(t, userId, workspaceId, a);
    await remember(t, turn.streamId, "Belongs to A.");

    // Memory belongs to the PROJECT, not to the chat that happened to produce
    // it. The intuitive-but-wrong behaviour would be to drag it along.
    await t.run(async (ctx) => {
      await ctx.db.patch(turn.threadId, { streamingMessageId: undefined });
    });
    await asUser.mutation(api.projects.moveThread, {
      threadId: turn.threadId,
      projectId: b,
    });

    const mem = (await rowsOf(t))[0];
    expect(mem?.projectId).toBe(a);
    await drain(t);
  });

  test("an archived project keeps its memory scoped, never falling back to global", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const p = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });
    const turn = await startTurn(t, userId, workspaceId, p);
    await remember(t, turn.streamId, "Archived-project note.");
    await asUser.mutation(api.projects.archive, { projectId: p, archived: true });

    const mem = (await rowsOf(t))[0];
    expect(mem?.scope).toBe("project");
    expect(mem?.projectId).toBe(p);

    // Still invisible to an ordinary chat.
    const pool = await t.run(async (ctx) => {
      const { loadMemoriesForDispatch } = await import("./memories");
      return loadMemoriesForDispatch(ctx, userId, workspaceId);
    });
    expect(pool).toEqual([]);
  });

  test("KNOWN BEHAVIOUR: the 200-memory active cap evicts across projects by HARD delete", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));
    const a = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "A",
    });
    const b = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "B",
    });

    // Fill to the cap with Project A memories, oldest first.
    await t.run(async (ctx) => {
      const base = Date.now() - 1_000_000;
      for (let i = 0; i < 200; i++) {
        await ctx.db.insert("userMemories", {
          userId,
          workspaceId,
          kind: "fact" as const,
          content: `a-${i}`,
          source: "explicit" as const,
          scope: "project" as const,
          projectId: a,
          status: "active" as const,
          normalizedKey: `a-${i}`,
          createdAt: base + i,
          updatedAt: base + i,
        });
      }
    });

    // One write in Project B evicts Project A's oldest — permanently.
    const tb = await startTurn(t, userId, workspaceId, b);
    await remember(t, tb.streamId, "b-new");

    const rows = await rowsOf(t);
    expect(rows.find((m) => m.content === "a-0")).toBeUndefined();
    expect(rows.find((m) => m.content === "b-new")).toBeDefined();

    // Pinned deliberately. The cap is a PER-USER storage bound that predates
    // Projects, and eviction is a hard delete rather than the reversible
    // `disabled` that forget uses. Making it per-scope would multiply what one
    // user can hold, so it is documented and asserted here instead of changed —
    // this test is what makes it a known property rather than a surprise.
    expect(rows.filter((m) => m.status === "active")).toHaveLength(200);
  });
});
