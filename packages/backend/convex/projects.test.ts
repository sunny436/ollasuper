/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

const PAGE = { numItems: 50, cursor: null };

/**
 * Project CRUD, lifecycle, and the Project<->chat relationship.
 *
 * The headline assertion in this file is the LAST describe block: a chat with
 * no project must behave exactly as it did before Projects existed. Everything
 * else here is new surface; that block is the one that proves nothing regressed.
 */

/**
 * Run scheduled functions to completion inside the test.
 *
 * threads.remove schedules internal.chat.threads.purge via runAfter(0, ...),
 * which is queued on a macrotask. finishInProgressScheduledFunctions only
 * awaits functions that have already STARTED, so we yield the event loop first
 * -- otherwise the purge starts after the test transaction has closed and
 * surfaces as an unhandled "Write outside of transaction".
 */
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

describe("project CRUD", () => {
  test("create validates the name and initialises server-side state", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "  Quarterly   planning  ",
    });

    const p = await asUser.query(api.projects.get, { projectId });
    // Whitespace collapsed and trimmed, exactly like thread titles.
    expect(p?.name).toBe("Quarterly planning");
    expect(p?.status).toBe("active");
    expect(p?.instructions).toBeNull();
    expect(p?.createdAt).toBeGreaterThan(0);

    // Empty and whitespace-only names are refused.
    for (const bad of ["", "   ", "\n\t "]) {
      await expect(
        asUser.mutation(api.projects.create, { workspaceId, name: bad }),
      ).rejects.toThrow(/cannot be empty/i);
    }
  });

  test("a very long name is bounded, not rejected", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "x".repeat(500),
    });
    const p = await asUser.query(api.projects.get, { projectId });
    expect(p?.name.length).toBe(200);
  });

  test("rename and setInstructions round-trip; instructions are stored only", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Before",
    });

    await asUser.mutation(api.projects.rename, { projectId, name: "After" });
    expect((await asUser.query(api.projects.get, { projectId }))?.name).toBe(
      "After",
    );

    await expect(
      asUser.mutation(api.projects.rename, { projectId, name: "  " }),
    ).rejects.toThrow(/cannot be empty/i);

    await asUser.mutation(api.projects.setInstructions, {
      projectId,
      instructions: "Always answer in British English.",
    });
    expect(
      (await asUser.query(api.projects.get, { projectId }))?.instructions,
    ).toBe("Always answer in British English.");

    // Clearing is explicit.
    await asUser.mutation(api.projects.setInstructions, {
      projectId,
      instructions: null,
    });
    expect(
      (await asUser.query(api.projects.get, { projectId }))?.instructions,
    ).toBeNull();
  });

  test("list is scoped by status and ordered newest-first", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const a = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "A",
    });
    const b = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "B",
    });
    const c = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "C",
    });

    const active = await asUser.query(api.projects.list, {
      workspaceId,
      paginationOpts: PAGE,
    });
    expect(active.page.map((p) => p._id).sort()).toEqual([a, b, c].sort());

    await asUser.mutation(api.projects.archive, {
      projectId: b,
      archived: true,
    });

    const stillActive = await asUser.query(api.projects.list, {
      workspaceId,
      paginationOpts: PAGE,
    });
    expect(stillActive.page.map((p) => p._id)).not.toContain(b);

    const archived = await asUser.query(api.projects.list, {
      workspaceId,
      status: "archived",
      paginationOpts: PAGE,
    });
    expect(archived.page.map((p) => p._id)).toEqual([b]);
  });

  test("list paginates rather than returning everything", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    for (let i = 0; i < 7; i++) {
      await asUser.mutation(api.projects.create, {
        workspaceId,
        name: `P${i}`,
      });
    }

    const first = await asUser.query(api.projects.list, {
      workspaceId,
      paginationOpts: { numItems: 3, cursor: null },
    });
    expect(first.page).toHaveLength(3);
    expect(first.isDone).toBe(false);

    const second = await asUser.query(api.projects.list, {
      workspaceId,
      paginationOpts: { numItems: 3, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(3);
    // No overlap between pages.
    const ids = new Set(first.page.map((p) => p._id));
    for (const p of second.page) expect(ids.has(p._id)).toBe(false);
  });
});

describe("project lifecycle", () => {
  test("archive and unarchive are reversible and idempotent", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Cycle",
    });

    // Repeating a transition must not corrupt state.
    await asUser.mutation(api.projects.archive, { projectId, archived: true });
    await asUser.mutation(api.projects.archive, { projectId, archived: true });
    expect((await asUser.query(api.projects.get, { projectId }))?.status).toBe(
      "archived",
    );

    await asUser.mutation(api.projects.archive, { projectId, archived: false });
    await asUser.mutation(api.projects.archive, { projectId, archived: false });
    expect((await asUser.query(api.projects.get, { projectId }))?.status).toBe(
      "active",
    );
  });

  test("an archived project stays readable and its chats stay listed", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Archived but alive",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });
    await asUser.mutation(api.projects.archive, { projectId, archived: true });

    // Readable — otherwise it could never be unarchived.
    expect(await asUser.query(api.projects.get, { projectId })).not.toBeNull();

    const chats = await asUser.query(api.projects.listThreads, {
      projectId,
      paginationOpts: PAGE,
    });
    expect(chats.page.map((c) => c._id)).toEqual([threadId]);
  });

  test("audit rows are written for create, rename and both archive directions", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Audited",
    });
    await asUser.mutation(api.projects.rename, { projectId, name: "Audited2" });
    await asUser.mutation(api.projects.archive, { projectId, archived: true });
    await asUser.mutation(api.projects.archive, { projectId, archived: false });

    const actions = await t.run(async (ctx) => {
      const rows = await ctx.db.query("auditLogs").collect();
      return rows.map((r) => r.action);
    });
    expect(actions).toContain("project.create");
    expect(actions).toContain("project.rename");
    expect(actions).toContain("project.archive");
    expect(actions).toContain("project.unarchive");
  });
});

describe("project <-> chat relationship", () => {
  test("a project chat is persistently linked and appears in the project list", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Linked",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });

    // Persisted on the row, not just in the client.
    const row = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(row?.projectId).toBe(projectId);

    const chats = await asUser.query(api.projects.listThreads, {
      projectId,
      paginationOpts: PAGE,
    });
    expect(chats.page.map((c) => c._id)).toEqual([threadId]);

    // And the thread reports its project for the header.
    const thread = await asUser.query(api.chat.threads.get, { threadId });
    expect(thread?.project?.name).toBe("Linked");
  });

  test("listThreads derives the workspace itself and never crosses projects", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const p1 = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "One",
    });
    const p2 = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Two",
    });
    const inP1 = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId: p1,
    });
    const inP2 = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId: p2,
    });
    // An ordinary chat, in no project at all.
    const loose = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
    });

    const one = await asUser.query(api.projects.listThreads, {
      projectId: p1,
      paginationOpts: PAGE,
    });
    expect(one.page.map((c) => c._id)).toEqual([inP1]);
    expect(one.page.map((c) => c._id)).not.toContain(inP2);
    expect(one.page.map((c) => c._id)).not.toContain(loose);

    // Every returned row really belongs to the project's own workspace.
    const rows = await t.run(async (ctx) =>
      Promise.all(one.page.map((c) => ctx.db.get(c._id))),
    );
    for (const r of rows) expect(r?.workspaceId).toBe(workspaceId);
  });

  test("the project link survives archive and restore of the chat", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Durable",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });

    // Archiving must not quietly turn a project chat into a loose one.
    await asUser.mutation(api.chat.threads.archive, {
      threadId,
      archived: true,
    });
    expect(
      await t.run(async (ctx) => (await ctx.db.get(threadId))?.projectId),
    ).toBe(projectId);

    // It moves to the archived list, not out of the project.
    const archived = await asUser.query(api.projects.listThreads, {
      projectId,
      status: "archived",
      paginationOpts: PAGE,
    });
    expect(archived.page.map((c) => c._id)).toEqual([threadId]);

    await asUser.mutation(api.chat.threads.archive, {
      threadId,
      archived: false,
    });
    const active = await asUser.query(api.projects.listThreads, {
      projectId,
      paginationOpts: PAGE,
    });
    expect(active.page.map((c) => c._id)).toEqual([threadId]);
  });

  test("a trashed project chat leaves the project list and cannot be resurrected by it", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Trash",
    });
    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });

    await asUser.mutation(api.chat.threads.remove, { threadId });

    for (const status of ["active", "archived"] as const) {
      const res = await asUser.query(api.projects.listThreads, {
        projectId,
        status,
        paginationOpts: PAGE,
      });
      expect(res.page).toEqual([]);
    }

    // Let the purge run; it is scheduled by remove() and would otherwise
    // execute after this test transaction closes.
    await drain(t);
  });

  test("FORWARD GUARD: a scheduled thread carrying a projectId never lists as a chat", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Guarded",
    });

    // No Phase 1 code path can produce this row: scheduled/execution.ts inserts
    // hidden threads with an explicit field list that has no projectId, and
    // Phase 1 never attaches a Project to a scheduled task. It is fabricated
    // here on purpose, as a guard for Phase 6 -- the moment scheduled tasks
    // learn about Projects, a project chat list that forgot to pin `status`
    // would start rendering scheduled executions as conversations.
    const hidden = await t.run(async (ctx) => {
      const now = Date.now();
      return ctx.db.insert("chatThreads", {
        workspaceId,
        userId,
        title: "Nightly digest",
        titleSource: "user",
        status: "scheduled",
        projectId,
        pinned: false,
        model: "deepseek-v4-flash",
        nextSeq: 0,
        messageCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        lastMessageAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    for (const status of ["active", "archived"] as const) {
      const res = await asUser.query(api.projects.listThreads, {
        projectId,
        status,
        paginationOpts: PAGE,
      });
      expect(res.page.map((c) => c._id)).not.toContain(hidden);
    }
  });
});

describe("backward compatibility: a chat with no project", () => {
  test("threads.create without a projectId is unchanged and stores no link", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
    });

    const row = await t.run(async (ctx) => ctx.db.get(threadId));
    // Absent, not null and not an empty string — exactly as every
    // pre-Projects row reads back.
    expect(row?.projectId).toBeUndefined();

    const thread = await asUser.query(api.chat.threads.get, { threadId });
    expect(thread?.project).toBeNull();
    expect(thread?.title).toBe("New chat");
    expect(thread?.status).toBe("active");
  });

  test("the ordinary lifecycle still works end to end", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
    });

    await asUser.mutation(api.chat.threads.rename, {
      threadId,
      title: "Renamed",
    });
    await asUser.mutation(api.chat.threads.setPinned, {
      threadId,
      pinned: true,
    });
    const pinned = await asUser.query(api.chat.threads.listPinned, {
      workspaceId,
    });
    expect(pinned.map((p) => p._id)).toEqual([threadId]);

    await asUser.mutation(api.chat.threads.setPinned, {
      threadId,
      pinned: false,
    });
    await asUser.mutation(api.chat.threads.archive, {
      threadId,
      archived: true,
    });
    const archived = await asUser.query(api.chat.threads.list, {
      workspaceId,
      status: "archived",
      paginationOpts: PAGE,
    });
    expect(archived.page.map((c) => c._id)).toEqual([threadId]);

    await asUser.mutation(api.chat.threads.archive, {
      threadId,
      archived: false,
    });
    await asUser.mutation(api.chat.threads.remove, { threadId });
    await asUser.mutation(api.chat.threads.restore, { threadId });

    const active = await asUser.query(api.chat.threads.list, {
      workspaceId,
      paginationOpts: PAGE,
    });
    expect(active.page.map((c) => c._id)).toEqual([threadId]);

    // Drained only now: purge is a no-op once the thread is active again, so
    // draining earlier would delete the very thread restore() just recovered.
    await drain(t);
  });

  test("the DEFAULT chat list still returns project and unassigned chats together", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, userId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Mixed",
    });
    const inProject = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });
    const loose = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
    });

    // PHASE 2 MADE THE CALL: project chats DO leave the conversation rail,
    // but via an opt-in `unassignedOnly` flag rather than by changing the
    // default. So this still asserts the unfiltered behaviour, which is what
    // Settings -> Archived Chats relies on to avoid stranding archived project
    // chats. The rail-side exclusion is covered in projects.chats.test.ts.
    const list = await asUser.query(api.chat.threads.list, {
      workspaceId,
      paginationOpts: PAGE,
    });
    expect(list.page.map((c) => c._id).sort()).toEqual(
      [inProject, loose].sort(),
    );
  });
});
