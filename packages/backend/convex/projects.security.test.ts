/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

const PAGE = { numItems: 20, cursor: null };

/**
 * Projects authorization.
 *
 * A Project is PRIVATE TO ITS CREATOR, so the boundary being tested here is the
 * one chat already uses (convex/chat/authz.ts), not the workspace boundary the
 * rest of the codebase uses. A legitimate same-workspace peer must be refused,
 * and must be refused with the SAME error a complete stranger gets — otherwise
 * the error becomes an existence oracle for someone else's projectId.
 *
 * Every call below goes through the public Convex API directly. The UI is never
 * in the trust path, so bypassing it entirely is the point.
 */

/** Two users in the SAME workspace — the hardest case for a user-private model. */
async function seedShared(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const alice = await ctx.db.insert("users", { email: "alice@t.test" });
    const bob = await ctx.db.insert("users", { email: "bob@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Shared",
      ownerId: alice,
      createdAt: Date.now(),
    });
    for (const [userId, role] of [
      [alice, "owner"],
      [bob, "member"],
    ] as const) {
      await ctx.db.insert("members", {
        workspaceId,
        userId,
        role,
        createdAt: Date.now(),
      });
    }
    return { alice, bob, workspaceId };
  });
}

/** A second, fully separate workspace that `other` owns and alice is not in. */
async function seedForeignWorkspace(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const other = await ctx.db.insert("users", { email: "other@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "Foreign",
      ownerId: other,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId,
      userId: other,
      role: "owner",
      createdAt: Date.now(),
    });
    return { other, workspaceId };
  });
}

describe("project authorization", () => {
  test("a same-workspace peer cannot read, rename, archive or list another user's project", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedShared(t);

    const projectId = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId, name: "Alice private" });

    const asBob = t.withIdentity(as(bob));

    // Reads return null — indistinguishable from a nonexistent project.
    expect(await asBob.query(api.projects.get, { projectId })).toBeNull();

    // Writes throw "Not found", never "Forbidden": the message must not confirm
    // that this id exists.
    await expect(
      asBob.mutation(api.projects.rename, { projectId, name: "hijacked" }),
    ).rejects.toThrow(/Not found/);
    await expect(
      asBob.mutation(api.projects.archive, { projectId, archived: true }),
    ).rejects.toThrow(/Not found/);
    await expect(
      asBob.mutation(api.projects.setInstructions, {
        projectId,
        instructions: "leak",
      }),
    ).rejects.toThrow(/Not found/);

    // Listing threads inside it yields nothing.
    const threads = await asBob.query(api.projects.listThreads, {
      projectId,
      paginationOpts: PAGE,
    });
    expect(threads.page).toEqual([]);

    // Bob's own project list never contains it.
    const list = await asBob.query(api.projects.list, {
      workspaceId,
      paginationOpts: PAGE,
    });
    expect(list.page).toEqual([]);

    // ...and the project is untouched.
    const still = await t
      .withIdentity(as(alice))
      .query(api.projects.get, { projectId });
    expect(still?.name).toBe("Alice private");
    expect(still?.status).toBe("active");
  });

  test("a non-member of the workspace cannot create a project in it", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seedShared(t);
    const { workspaceId: foreignWs } = await seedForeignWorkspace(t);

    await expect(
      t
        .withIdentity(as(alice))
        .mutation(api.projects.create, {
          workspaceId: foreignWs,
          name: "trespass",
        }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("an owner removed from the workspace loses access to their own project", async () => {
    const t = convexTest(schema, modules);
    const { alice, workspaceId } = await seedShared(t);

    const projectId = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId, name: "Orphaned" });

    // Remove the membership row — orgs.removeMember does not (and should not)
    // know about projects, so this is the defense-in-depth path.
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("members")
        .withIndex("by_user_workspace", (q) =>
          q.eq("userId", alice).eq("workspaceId", workspaceId),
        )
        .unique();
      if (m) await ctx.db.delete(m._id);
    });

    await expect(
      t
        .withIdentity(as(alice))
        .mutation(api.projects.rename, { projectId, name: "still mine?" }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("malformed and nonexistent project ids are safe, never validator errors", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seedShared(t);
    const asAlice = t.withIdentity(as(alice));

    // A garbage string from a typo'd URL must NOT reach a v.id() validator:
    // that throws ArgumentValidationError, which the Convex client logs via
    // console.error, which fails every e2e run.
    for (const bad of ["not-an-id", "", "kg2abc123xyz"]) {
      expect(await asAlice.query(api.projects.get, { projectId: bad })).toBeNull();
      const res = await asAlice.query(api.projects.listThreads, {
        projectId: bad,
        paginationOpts: PAGE,
      });
      expect(res.page).toEqual([]);
    }
  });

  test("a signed-out caller reads nothing and cannot create", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await seedShared(t);

    const list = await t.query(api.projects.list, {
      workspaceId,
      paginationOpts: PAGE,
    });
    expect(list.page).toEqual([]);

    await expect(
      t.mutation(api.projects.create, { workspaceId, name: "anon" }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("ownership is never taken from the caller's arguments", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedShared(t);

    // There is no owner argument to forge; assert the created row belongs to
    // the authenticated caller regardless of who else is in the workspace.
    const projectId = await t
      .withIdentity(as(bob))
      .mutation(api.projects.create, { workspaceId, name: "Bob project" });

    const row = await t.run(async (ctx) => ctx.db.get(projectId));
    expect(row?.userId).toBe(bob);
    expect(row?.userId).not.toBe(alice);
    // Lifecycle is server-initialised, not client-supplied.
    expect(row?.status).toBe("active");
  });
});

describe("project <-> thread authorization", () => {
  test("a user cannot attach a thread to another user's project", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedShared(t);

    const aliceProject = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId, name: "Alice only" });

    // Bob is a legitimate member of the same workspace. He must still be
    // refused, and with the non-committal error.
    await expect(
      t.withIdentity(as(bob)).mutation(api.chat.threads.create, {
        workspaceId,
        projectId: aliceProject,
      }),
    ).rejects.toThrow(/Not found/);

    // Nothing was created.
    const threads = await t.run(async (ctx) =>
      ctx.db
        .query("chatThreads")
        .withIndex("by_user_ws_status_updated", (q) =>
          q
            .eq("userId", bob)
            .eq("workspaceId", workspaceId)
            .eq("status", "active"),
        )
        .collect(),
    );
    expect(threads).toEqual([]);
  });

  test("a thread cannot be attached to a project across a workspace boundary", async () => {
    const t = convexTest(schema, modules);
    const { alice, workspaceId: wsA } = await seedShared(t);

    // Alice legitimately belongs to a SECOND workspace and owns a project
    // there. She owns both sides, so ONLY the workspace mismatch makes this
    // illegal -- which is what makes it the real test of INVARIANT 4.
    const wsB = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaces", {
        name: "Alice second",
        ownerId: alice,
        createdAt: Date.now(),
      });
      await ctx.db.insert("members", {
        workspaceId: id,
        userId: alice,
        role: "owner",
        createdAt: Date.now(),
      });
      return id;
    });

    const projectInB = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId: wsB, name: "In B" });

    await expect(
      t.withIdentity(as(alice)).mutation(api.chat.threads.create, {
        workspaceId: wsA,
        projectId: projectInB,
      }),
    ).rejects.toThrow(/Not found/);

    // The same project IS usable from its own workspace.
    const ok = await t
      .withIdentity(as(alice))
      .mutation(api.chat.threads.create, {
        workspaceId: wsB,
        projectId: projectInB,
      });
    expect(ok).toBeDefined();
  });

  test("a garbage projectId throws and creates NO thread", async () => {
    const t = convexTest(schema, modules);
    const { alice, workspaceId } = await seedShared(t);

    // The G1 failure mode: a chat that silently lands OUTSIDE the project the
    // user asked for is worse than an error, because the user cannot see it.
    await expect(
      t.withIdentity(as(alice)).mutation(api.chat.threads.create, {
        workspaceId,
        projectId: "not-a-real-id",
      }),
    ).rejects.toThrow(/Not found/);

    const threads = await t.run(async (ctx) =>
      ctx.db.query("chatThreads").collect(),
    );
    expect(threads).toEqual([]);
  });

  test("an archived project refuses new chats but keeps its existing ones usable", async () => {
    const t = convexTest(schema, modules);
    const { alice, workspaceId } = await seedShared(t);
    const asAlice = t.withIdentity(as(alice));

    const projectId = await asAlice.mutation(api.projects.create, {
      workspaceId,
      name: "Winding down",
    });
    const existing = await asAlice.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });

    await asAlice.mutation(api.projects.archive, { projectId, archived: true });

    // No new work in an archived project.
    await expect(
      asAlice.mutation(api.chat.threads.create, { workspaceId, projectId }),
    ).rejects.toThrow(/archived/i);

    // The existing chat is untouched and still fully readable.
    const thread = await asAlice.query(api.chat.threads.get, {
      threadId: existing,
    });
    expect(thread).not.toBeNull();
    expect(thread?.project?.name).toBe("Winding down");

    // Unarchiving restores creation.
    await asAlice.mutation(api.projects.archive, { projectId, archived: false });
    const another = await asAlice.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });
    expect(another).toBeDefined();
  });

  test("a project chat is invisible to a same-workspace peer", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedShared(t);

    const projectId = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId, name: "Alice work" });
    const threadId = await t
      .withIdentity(as(alice))
      .mutation(api.chat.threads.create, { workspaceId, projectId });

    const asBob = t.withIdentity(as(bob));
    expect(await asBob.query(api.chat.threads.get, { threadId })).toBeNull();
    await expect(
      asBob.mutation(api.chat.threads.rename, { threadId, title: "mine now" }),
    ).rejects.toThrow(/Not found/);
  });

  test("thread.get never leaks project metadata the caller does not own", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedShared(t);

    // Force the inconsistent state directly: Bob owns the thread, Alice owns
    // the project. No public path can produce this, which is exactly why the
    // guard in threads.get must not trust the denormalised link.
    const aliceProject = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId, name: "Secret name" });
    const bobThread = await t
      .withIdentity(as(bob))
      .mutation(api.chat.threads.create, { workspaceId });
    await t.run(async (ctx) => {
      await ctx.db.patch(bobThread, { projectId: aliceProject });
    });

    const seen = await t
      .withIdentity(as(bob))
      .query(api.chat.threads.get, { threadId: bobThread });
    expect(seen).not.toBeNull();
    expect(seen?.project).toBeNull();
  });
});
