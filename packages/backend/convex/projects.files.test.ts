/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const PAGE = { numItems: 50, cursor: null };

/**
 * PHASE 3 — Project file membership and the retrieval scope it produces.
 *
 * The Convex half of the Project-RAG boundary. Postgres never learns what a
 * Project is: what reaches it is a resolved list of file ids computed HERE, from
 * an authorized Project, and sent straight to Python. So this file has to prove
 * two things — that membership cannot be forged, and that the resolved scope is
 * exactly right, including when it is EMPTY.
 *
 * The SQL half (an empty list must narrow to nothing rather than widening to the
 * account corpus) lives in services/ai/tests/test_retrieve_db.py and
 * test_project_scope.py.
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

/**
 * A userFiles row, inserted directly.
 *
 * saveFile needs a real storage blob, and none of these tests are about the
 * upload path — they are about membership and scope resolution.
 */
async function seedFile(
  t: ReturnType<typeof convexTest>,
  opts: {
    userId: Id<"users">;
    workspaceId: Id<"workspaces">;
    name: string;
    ingestId: string;
    status?: "processing" | "ready" | "failed";
  },
) {
  return t.run(async (ctx) => {
    const now = Date.now();
    return ctx.db.insert("userFiles", {
      userId: opts.userId,
      workspaceId: opts.workspaceId,
      name: opts.name,
      size: 100,
      contentType: "text/plain",
      ingestId: opts.ingestId,
      status: opts.status ?? "ready",
      attempts: 0,
      contentHash: `${opts.ingestId}-hash`,
      createdAt: now,
      updatedAt: now,
    });
  });
}

const scopeOf = (t: ReturnType<typeof convexTest>, projectId: Id<"projects">) =>
  t.run(async (ctx) => {
    const { projectFileIngestIds } = await import("./projects");
    return projectFileIngestIds(ctx, projectId);
  });

describe("project file membership", () => {
  test("link is authorized, idempotent, and listed", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Sources",
    });
    const fileId = await seedFile(t, {
      userId,
      workspaceId,
      name: "policy.pdf",
      ingestId: "ing-1",
    });

    await asUser.mutation(api.projects.linkFile, { projectId, fileId });
    // Uploads dedup, so "upload a file you already own" lands here twice. A
    // second link must not create a second edge.
    await asUser.mutation(api.projects.linkFile, { projectId, fileId });

    const edges = await t.run(async (ctx) =>
      ctx.db.query("projectFiles").collect(),
    );
    expect(edges).toHaveLength(1);

    const listed = await asUser.query(api.projects.listFiles, {
      projectId,
      paginationOpts: PAGE,
    });
    expect(listed.page.map((f) => f.name)).toEqual(["policy.pdf"]);
    // The ingestId is a capability AND the retrieval scope — it must never be
    // handed to a browser.
    expect(JSON.stringify(listed.page)).not.toContain("ing-1");
  });

  test("unlink drops the edge and keeps the file", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });
    const fileId = await seedFile(t, {
      userId,
      workspaceId,
      name: "a.pdf",
      ingestId: "ing-a",
    });
    await asUser.mutation(api.projects.linkFile, { projectId, fileId });
    await asUser.mutation(api.projects.unlinkFile, { projectId, fileId });

    expect(await t.run(async (ctx) => ctx.db.query("projectFiles").collect()))
      .toEqual([]);
    // The file itself survives — it may still be a member of another Project,
    // and it is still an ordinary account file.
    expect(await t.run(async (ctx) => ctx.db.get(fileId))).not.toBeNull();
  });

  test("one file can belong to two projects at once", async () => {
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
    // Dedup guarantees this: re-uploading identical content returns the SAME
    // userFiles row, so membership has to be a join or the second Project could
    // never have it.
    const fileId = await seedFile(t, {
      userId,
      workspaceId,
      name: "shared.pdf",
      ingestId: "ing-shared",
    });

    await asUser.mutation(api.projects.linkFile, { projectId: a, fileId });
    await asUser.mutation(api.projects.linkFile, { projectId: b, fileId });

    expect(await scopeOf(t, a)).toEqual(["ing-shared"]);
    expect(await scopeOf(t, b)).toEqual(["ing-shared"]);

    // Removing it from A leaves B untouched.
    await asUser.mutation(api.projects.unlinkFile, { projectId: a, fileId });
    expect(await scopeOf(t, a)).toEqual([]);
    expect(await scopeOf(t, b)).toEqual(["ing-shared"]);
  });

  test("deleting a file removes its project edges", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });
    const fileId = await seedFile(t, {
      userId,
      workspaceId,
      name: "gone.pdf",
      ingestId: "ing-gone",
    });
    await asUser.mutation(api.projects.linkFile, { projectId, fileId });

    await asUser.mutation(api.userFiles.remove, { fileId });

    // No dangling edge, and the scope stops naming it immediately — a deleted
    // file must not survive as a retrievable id.
    expect(await t.run(async (ctx) => ctx.db.query("projectFiles").collect()))
      .toEqual([]);
    expect(await scopeOf(t, projectId)).toEqual([]);
    await drain(t);
  });
});

describe("retrieval scope resolution", () => {
  test("only READY files enter the scope", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Mixed",
    });
    for (const [name, ingestId, status] of [
      ["ready.pdf", "ing-ready", "ready"],
      ["busy.pdf", "ing-busy", "processing"],
      ["bad.pdf", "ing-bad", "failed"],
    ] as const) {
      const fileId = await seedFile(t, {
        userId,
        workspaceId,
        name,
        ingestId,
        status,
      });
      await asUser.mutation(api.projects.linkFile, { projectId, fileId });
    }

    // A file still parsing has no chunks; a failed one has nothing
    // trustworthy. Same gate the account-wide path uses.
    expect(await scopeOf(t, projectId)).toEqual(["ing-ready"]);
  });

  test("a project with no files resolves to an EMPTY scope, not a null one", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Empty",
    });
    // The user DOES own a file — it is simply not in this Project. This is the
    // exact state that used to leak the whole corpus.
    await seedFile(t, {
      userId,
      workspaceId,
      name: "elsewhere.pdf",
      ingestId: "ing-elsewhere",
    });

    const scope = await scopeOf(t, projectId);
    expect(scope).toEqual([]);
    expect(scope).not.toBeNull();
  });

  test("dispatchPayload sends [] for an empty project, null for an ordinary chat", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    await seedFile(t, {
      userId,
      workspaceId,
      name: "account.pdf",
      ingestId: "ing-account",
    });
    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Empty",
    });
    const inProject = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });
    const loose = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
    });

    const a = await asUser.mutation(api.chat.messages.send, {
      threadId: inProject,
      content: "what do my files say",
      clientId: "p1",
    });
    const b = await asUser.mutation(api.chat.messages.send, {
      threadId: loose,
      content: "what do my files say",
      clientId: "l1",
    });
    await drain(t);

    const pa = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: a.streamId as string,
    });
    const pb = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: b.streamId as string,
    });

    // The three states, at the seam that produces them.
    expect(pa?.ragFileIds).toEqual([]);
    expect(pb?.ragFileIds).toBeNull();
    // And the gate follows the scope, not the account: an empty Project reports
    // 0 so the search_knowledge tool is not even bound.
    expect(pa?.ragFileCount).toBe(0);
    expect(pb?.ragFileCount).toBe(1);
  });

  test("a populated project sends exactly its own ingestIds", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "Full",
    });
    const mine = await seedFile(t, {
      userId,
      workspaceId,
      name: "mine.pdf",
      ingestId: "ing-mine",
    });
    await asUser.mutation(api.projects.linkFile, { projectId, fileId: mine });
    // An account file deliberately NOT in the Project.
    await seedFile(t, {
      userId,
      workspaceId,
      name: "other.pdf",
      ingestId: "ing-other",
    });

    const threadId = await asUser.mutation(api.chat.threads.create, {
      workspaceId,
      projectId,
    });
    const sent = await asUser.mutation(api.chat.messages.send, {
      threadId,
      content: "summarise my document",
      clientId: "c1",
    });
    await drain(t);

    const payload = await t.query(internal.chat.stream.dispatchPayload, {
      streamId: sent.streamId as string,
    });
    expect(payload?.ragFileIds).toEqual(["ing-mine"]);
    expect(payload?.ragFileIds).not.toContain("ing-other");
    expect(payload?.ragFileCount).toBe(1);
  });

  test("unlinking narrows the scope on the very next turn", async () => {
    const t = convexTest(schema, modules);
    const { userId, workspaceId } = await seed(t);
    const asUser = t.withIdentity(as(userId));

    const projectId = await asUser.mutation(api.projects.create, {
      workspaceId,
      name: "P",
    });
    const fileId = await seedFile(t, {
      userId,
      workspaceId,
      name: "doc.pdf",
      ingestId: "ing-doc",
    });
    await asUser.mutation(api.projects.linkFile, { projectId, fileId });
    expect(await scopeOf(t, projectId)).toEqual(["ing-doc"]);

    await asUser.mutation(api.projects.unlinkFile, { projectId, fileId });
    // Resolved per dispatch, so there is no cached scope to go stale.
    expect(await scopeOf(t, projectId)).toEqual([]);
  });
});

describe("project file authorization", () => {
  async function seedTwo(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) => {
      const alice = await ctx.db.insert("users", { email: "a@t.test" });
      const bob = await ctx.db.insert("users", { email: "b@t.test" });
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

  test("a peer cannot link their file into another user's project", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedTwo(t);

    const aliceProject = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId, name: "Alice" });
    const bobFile = await seedFile(t, {
      userId: bob,
      workspaceId,
      name: "bob.pdf",
      ingestId: "ing-bob",
    });

    await expect(
      t.withIdentity(as(bob)).mutation(api.projects.linkFile, {
        projectId: aliceProject,
        fileId: bobFile,
      }),
    ).rejects.toThrow(/Not found/);
    expect(await scopeOf(t, aliceProject)).toEqual([]);
  });

  test("a user cannot link someone else's file into their own project", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedTwo(t);

    const bobProject = await t
      .withIdentity(as(bob))
      .mutation(api.projects.create, { workspaceId, name: "Bob" });
    const aliceFile = await seedFile(t, {
      userId: alice,
      workspaceId,
      name: "secret.pdf",
      ingestId: "ing-secret",
    });

    // Owning the Project is not enough — the FILE is checked independently.
    await expect(
      t.withIdentity(as(bob)).mutation(api.projects.linkFile, {
        projectId: bobProject,
        fileId: aliceFile,
      }),
    ).rejects.toThrow(/Not found/);
    expect(await scopeOf(t, bobProject)).toEqual([]);
  });

  test("a file cannot be linked across a workspace boundary", async () => {
    const t = convexTest(schema, modules);
    const { alice, workspaceId: wsA } = await seedTwo(t);

    const wsB = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaces", {
        name: "Second",
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

    const projectInA = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId: wsA, name: "In A" });
    // Alice owns both sides; only the workspace mismatch makes this illegal.
    const fileInB = await seedFile(t, {
      userId: alice,
      workspaceId: wsB,
      name: "b.pdf",
      ingestId: "ing-b",
    });

    await expect(
      t.withIdentity(as(alice)).mutation(api.projects.linkFile, {
        projectId: projectInA,
        fileId: fileInB,
      }),
    ).rejects.toThrow(/Not found/);
  });

  test("an archived project accepts no new files but can still give them up", async () => {
    const t = convexTest(schema, modules);
    const { alice, workspaceId } = await seedTwo(t);
    const asAlice = t.withIdentity(as(alice));

    const projectId = await asAlice.mutation(api.projects.create, {
      workspaceId,
      name: "Winding down",
    });
    const kept = await seedFile(t, {
      userId: alice,
      workspaceId,
      name: "kept.pdf",
      ingestId: "ing-kept",
    });
    const extra = await seedFile(t, {
      userId: alice,
      workspaceId,
      name: "extra.pdf",
      ingestId: "ing-extra",
    });
    await asAlice.mutation(api.projects.linkFile, { projectId, fileId: kept });
    await asAlice.mutation(api.projects.archive, { projectId, archived: true });

    await expect(
      asAlice.mutation(api.projects.linkFile, { projectId, fileId: extra }),
    ).rejects.toThrow(/archived/i);

    // Removal stays available, or a file would be trapped in an archived
    // Project with no way out.
    await asAlice.mutation(api.projects.unlinkFile, { projectId, fileId: kept });
    expect(await scopeOf(t, projectId)).toEqual([]);
  });

  test("a peer sees nothing through listFiles", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seedTwo(t);

    const projectId = await t
      .withIdentity(as(alice))
      .mutation(api.projects.create, { workspaceId, name: "Alice" });
    const fileId = await seedFile(t, {
      userId: alice,
      workspaceId,
      name: "private.pdf",
      ingestId: "ing-priv",
    });
    await t
      .withIdentity(as(alice))
      .mutation(api.projects.linkFile, { projectId, fileId });

    const seen = await t
      .withIdentity(as(bob))
      .query(api.projects.listFiles, { projectId, paginationOpts: PAGE });
    expect(seen.page).toEqual([]);
  });

  test("a malformed project id is safe, never a validator error", async () => {
    const t = convexTest(schema, modules);
    const { alice } = await seedTwo(t);
    for (const bad of ["not-an-id", "", "kg2abc123xyz"]) {
      const res = await t
        .withIdentity(as(alice))
        .query(api.projects.listFiles, {
          projectId: bad,
          paginationOpts: PAGE,
        });
      expect(res.page).toEqual([]);
    }
  });
});
