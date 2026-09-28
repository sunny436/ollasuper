/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;

async function seed(t: TestT) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "owner@t.test" });
    const otherId = await ctx.db.insert("users", { email: "other@t.test" });
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
    const threadId = await ctx.db.insert("chatThreads", {
      userId,
      workspaceId,
      title: "t",
      titleSource: "user",
      status: "active",
      pinned: false,
      model: "m",
      nextSeq: 3,
      messageCount: 2,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const messageId = await ctx.db.insert("chatMessages", {
      threadId,
      userId,
      workspaceId,
      role: "assistant",
      content: "",
      seq: 2,
      status: "streaming",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const streamId = `stream_${Math.random()}`;
    await ctx.db.insert("chatStreams", {
      streamId,
      messageId,
      threadId,
      workspaceId,
      userId,
      status: "running",
      cancelRequested: false,
      chunkSeq: -1,
      committedText: "",
      committedSeq: -1,
      heartbeatAt: Date.now(),
      startedAt: Date.now(),
      attempts: 0,
      deadlineAt: Date.now() + 300_000,
    });
    return { streamId, threadId, messageId, userId, otherId };
  });
}

async function store(t: TestT, streamId: string) {
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["PDF-BYTES"], { type: "application/pdf" })),
  );
  const res = await t.run((ctx) =>
    ctx.runMutation(internal.chat.artifacts.registerArtifact, {
      streamId,
      storageId,
      filename: "report.pdf",
      format: "pdf",
      mime: "application/pdf",
      size: 9,
    }),
  );
  return { storageId, ...res };
}

describe("chat artifacts", () => {
  test("owner store → mint → resolve round-trip serves the blob", async () => {
    const t = convexTest(schema, modules);
    const { streamId, userId } = await seed(t);
    const { artifactId } = await store(t, streamId);
    expect(artifactId).toBeTruthy();

    const { token, filename } = await t
      .withIdentity(as(userId))
      .mutation(api.chat.artifacts.mintDownload, {
        artifactId: artifactId as string,
      });
    expect(filename).toBe("report.pdf");

    const resolved = await t.run((ctx) =>
      ctx.runQuery(internal.chat.artifacts.resolveDownload, { token }),
    );
    expect(resolved?.mime).toBe("application/pdf");
    const hasBlob = await t.run(
      async (ctx) => (await ctx.storage.get(resolved!.storageId)) !== null,
    );
    expect(hasBlob).toBe(true);
  });

  test("a non-owner cannot mint a download (no existence oracle)", async () => {
    const t = convexTest(schema, modules);
    const { streamId, otherId } = await seed(t);
    const { artifactId } = await store(t, streamId);
    await expect(
      t
        .withIdentity(as(otherId))
        .mutation(api.chat.artifacts.mintDownload, {
          artifactId: artifactId as string,
        }),
    ).rejects.toThrow("Not found");
  });

  test("a bogus or malformed token resolves to null", async () => {
    const t = convexTest(schema, modules);
    const nope = await t.run((ctx) =>
      ctx.runQuery(internal.chat.artifacts.resolveDownload, {
        token: "not-a-real-token",
      }),
    );
    expect(nope).toBeNull();
  });

  test("a malformed artifactId is Not found, never a validation error", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seed(t);
    await expect(
      t
        .withIdentity(as(userId))
        .mutation(api.chat.artifacts.mintDownload, { artifactId: "garbage" }),
    ).rejects.toThrow("Not found");
  });

  test("purging the thread deletes the artifact row; the bytes go with the Library copy", async () => {
    const t = convexTest(schema, modules);
    const { streamId, threadId } = await seed(t);
    const { storageId } = await store(t, streamId);
    // A generated file is also a Library file on the SAME blob.
    const lib = await t.run((ctx) =>
      ctx.db
        .query("userFiles")
        .withIndex("by_storage", (q) => q.eq("storageId", storageId))
        .unique(),
    );
    expect(lib?.source).toBe("generated");
    // Purge only runs on a trashed thread.
    await t.run(async (ctx) => {
      await ctx.db.patch(threadId, { status: "trashed" });
    });
    await t.mutation(internal.chat.threads.purge, { threadId });
    const rows = await t.run((ctx) => ctx.db.query("chatArtifacts").collect());
    expect(rows.length).toBe(0);
    // Deleting the chat does NOT delete the Library file (or its bytes)...
    const kept = await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null);
    expect(kept).toBe(true);
    // ...deleting the Library file does, once nothing else references them.
    const { removeLibraryFile } = await import("./libraryCore");
    await t.run(async (ctx) => {
      const f = await ctx.db.get(lib!._id);
      if (f) await removeLibraryFile(ctx, f, "user");
    });
    const gone = await t.run(async (ctx) => (await ctx.storage.get(storageId)) === null);
    expect(gone).toBe(true);
  });

  // --- Documents inline preview (child artifacts + previewUrls) ---------------
  async function storePreview(
    t: TestT,
    streamId: string,
    parentArtifactId: string,
    page: number,
  ) {
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["PNG-BYTES"], { type: "image/png" })),
    );
    return t.run((ctx) =>
      ctx.runMutation(internal.chat.artifacts.registerArtifact, {
        streamId,
        storageId,
        filename: `preview-${page}.png`,
        format: "png",
        mime: "image/png",
        size: 9,
        parentArtifactId,
        role: "preview",
        page,
      }),
    );
  }

  test("owner gets ordered preview page urls; a non-owner gets none", async () => {
    const t = convexTest(schema, modules);
    const { streamId, userId, otherId } = await seed(t);
    const { artifactId } = await store(t, streamId);
    // insert previews out of order to prove sorting by page
    await storePreview(t, streamId, artifactId as string, 2);
    await storePreview(t, streamId, artifactId as string, 1);

    const mine = await t
      .withIdentity(as(userId))
      .query(api.chat.artifacts.previewUrls, {
        artifactId: artifactId as string,
      });
    expect(mine.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(mine.pages.every((p) => typeof p.url === "string" && p.url)).toBe(true);

    const theirs = await t
      .withIdentity(as(otherId))
      .query(api.chat.artifacts.previewUrls, {
        artifactId: artifactId as string,
      });
    expect(theirs.pages).toEqual([]);
  });

  test("previewUrls on a malformed id returns no pages (no oracle)", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seed(t);
    const res = await t
      .withIdentity(as(userId))
      .query(api.chat.artifacts.previewUrls, { artifactId: "garbage" });
    expect(res.pages).toEqual([]);
  });

  test("purging the thread also deletes preview child rows + blobs", async () => {
    const t = convexTest(schema, modules);
    const { streamId, threadId } = await seed(t);
    const { artifactId } = await store(t, streamId);
    await storePreview(t, streamId, artifactId as string, 1);
    await t.run((ctx) => ctx.db.patch(threadId, { status: "trashed" }));
    await t.mutation(internal.chat.threads.purge, { threadId });
    const rows = await t.run((ctx) => ctx.db.query("chatArtifacts").collect());
    expect(rows.length).toBe(0); // parent + preview child both gone
  });
});
