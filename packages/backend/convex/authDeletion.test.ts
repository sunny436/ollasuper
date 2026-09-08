import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

/** finishInProgressScheduledFunctions only awaits STARTED functions, and a
 *  self-rescheduling cascade starts the next pass from inside the current one —
 *  so pump the loop a few times to run the whole chain to completion. */
async function drain(t: TestT) {
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();
  }
}

async function seedUserWithContent(t: TestT) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "gone@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    const threadId = await ctx.db.insert("chatThreads", {
      workspaceId: ws,
      userId,
      title: "private",
      titleSource: "auto",
      status: "active",
      pinned: false,
      model: "anthropic/claude-sonnet-5",
      nextSeq: 1,
      messageCount: 1,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const messageId = await ctx.db.insert("chatMessages", {
      workspaceId: ws,
      threadId,
      userId,
      role: "user",
      seq: 0,
      content: "secret content",
      status: "complete",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // An attachment and an artifact, each with a real stored blob.
    const attBlob = await ctx.storage.store(
      new Blob(["attachment-bytes"], { type: "text/plain" }),
    );
    await ctx.db.insert("chatAttachments", {
      workspaceId: ws,
      userId,
      threadId,
      messageId,
      storageId: attBlob,
      name: "a.txt",
      size: 16,
      contentType: "text/plain",
      kind: "text",
      status: "ready",
      createdAt: Date.now(),
    });
    const artBlob = await ctx.storage.store(
      new Blob(["artifact-bytes"], { type: "text/plain" }),
    );
    await ctx.db.insert("chatArtifacts", {
      workspaceId: ws,
      threadId,
      messageId,
      userId,
      storageId: artBlob,
      streamId: "s-artifact",
      filename: "out.txt",
      format: "txt",
      mime: "text/plain",
      size: 14,
      createdAt: Date.now(),
    });
    // A PUBLIC share of this conversation — the security-relevant survivor.
    const shareToken = "tok_" + "a".repeat(40);
    await ctx.db.insert("chatShares", {
      token: shareToken,
      userId,
      workspaceId: ws,
      chatId: threadId,
      shareType: "full_chat",
      title: "shared",
      snapshot: "{}",
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
    });
    // The avatar blob.
    const avatar = await ctx.storage.store(
      new Blob(["\x89PNG-face"], { type: "image/png" }),
    );
    await ctx.db.patch(userId, { imageId: avatar });
    return { userId, ws, threadId, attBlob, artBlob, avatar, shareToken };
  });
}

describe("account deletion is durable", () => {
  test("a deleted user's share stops working — before ANY other purge", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedUserWithContent(t);

    // Baseline: the share is live and resolvable by its token.
    const before = await t.run((ctx) =>
      ctx.db
        .query("chatShares")
        .withIndex("by_token", (q) => q.eq("token", seed.shareToken))
        .unique(),
    );
    expect(before).not.toBeNull();

    // Delete, then run the cascade to completion.
    await t.run((ctx) =>
      ctx.runMutation(internal.users.deleteUserAccount, { userId: seed.userId }),
    );
    await drain(t);

    const after = await t.run((ctx) =>
      ctx.db
        .query("chatShares")
        .withIndex("by_token", (q) => q.eq("token", seed.shareToken))
        .unique(),
    );
    expect(after).toBeNull(); // public access revoked
  });

  test("private content and its blobs are purged, not orphaned", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedUserWithContent(t);

    await t.run((ctx) =>
      ctx.runMutation(internal.users.deleteUserAccount, { userId: seed.userId }),
    );
    await drain(t);

    await t.run(async (ctx) => {
      // rows gone
      const threads = await ctx.db
        .query("chatThreads")
        .withIndex("by_user_ws_status_updated", (q) =>
          q.eq("userId", seed.userId),
        )
        .collect();
      expect(threads).toEqual([]);
      const msgs = await ctx.db
        .query("chatMessages")
        .withIndex("by_thread_seq", (q) => q.eq("threadId", seed.threadId))
        .collect();
      expect(msgs).toEqual([]);
      const atts = await ctx.db
        .query("chatAttachments")
        .withIndex("by_thread", (q) => q.eq("threadId", seed.threadId))
        .collect();
      expect(atts).toEqual([]);

      // blobs gone (system table — get() returns null once deleted)
      for (const blob of [seed.attBlob, seed.artBlob, seed.avatar]) {
        expect(await ctx.db.system.get(blob)).toBeNull();
      }
      // the user row itself is gone
      expect(await ctx.db.get(seed.userId)).toBeNull();
    });
  });

  test("the cascade is idempotent — a second run is a no-op, not a crash", async () => {
    const t = convexTest(schema, modules);
    const seed = await seedUserWithContent(t);
    await t.run((ctx) =>
      ctx.runMutation(internal.users.deleteUserAccount, { userId: seed.userId }),
    );
    await drain(t);
    // Run it again by hand — resumes/retries must not throw on already-gone data.
    await t.run((ctx) =>
      ctx.runMutation(internal.authDeletion.cascadeUserContent, {
        userId: seed.userId,
      }),
    );
    await drain(t);
    const threads = await t.run((ctx) =>
      ctx.db
        .query("chatThreads")
        .withIndex("by_user_ws_status_updated", (q) =>
          q.eq("userId", seed.userId as Id<"users">),
        )
        .collect(),
    );
    expect(threads).toEqual([]);
  });
});
