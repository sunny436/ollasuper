import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { activationNeedles, mentionsConnector, slugOfToolId } from "./mcp/activation";
import schema from "./schema";

/**
 * Per-thread activation of untrusted connectors (audit H-06). The plane
 * composes an untrusted connector only when `activated` is true for the
 * thread; here is how the flag gets set and how it travels.
 */
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

describe("matching", () => {
  test("slugs answer to their parts, folded", () => {
    expect(activationNeedles("google-drive")).toEqual(["googledrive", "google", "drive"]);
    expect(activationNeedles("qa-redteam")).toEqual(["qaredteam", "redteam"]);
    expect(mentionsConnector("look this up on Context7 please", "context7")).toBe(true);
    expect(mentionsConnector("use the QA Red-Team connector", "qa-redteam")).toBe(true);
    expect(mentionsConnector("what's in my Google Drive?", "google-drive")).toBe(true);
    expect(mentionsConnector("summarise my week", "context7")).toBe(false);
    expect(mentionsConnector("", "context7")).toBe(false);
  });

  test("tool ids map back to slugs", () => {
    expect(slugOfToolId("mcp:context7:resolve-library-id")).toBe("context7");
    expect(slugOfToolId("mcp:qa-redteam:read_ok")).toBe("qa-redteam");
    expect(slugOfToolId("search_web")).toBeNull();
    expect(slugOfToolId("mcp:")).toBeNull();
  });
});

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "o@t.test" });
    const ws = await ctx.db.insert("workspaces", { name: "WS", ownerId: owner, createdAt: Date.now() });
    await ctx.db.insert("members", { workspaceId: ws, userId: owner, role: "owner", createdAt: Date.now() });
    const now = Date.now();
    const threadId = await ctx.db.insert("chatThreads", {
      workspaceId: ws,
      userId: owner,
      title: "t",
      titleSource: "auto",
      status: "active",
      pinned: false,
      model: "anthropic/claude-sonnet-5",
      nextSeq: 1,
      messageCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const mk = (slug: string) =>
      ctx.db.insert("mcpConnections", {
        userId: owner,
        workspaceId: ws,
        serverName: `s/${slug}`,
        slug,
        version: "1.0.0",
        versionMode: "latest_at_connect",
        transport: "streamable-http",
        authKind: "none",
        status: "ready",
        createdAt: now,
        updatedAt: now,
      });
    await mk("context7");
    await mk("qa-redteam");
    return { owner, ws, threadId };
  });
}

describe("activation travels with the thread", () => {
  test("naming a connector in a message activates it for that thread only", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const other = await t.run((ctx) =>
      ctx.db.insert("chatThreads", {
        workspaceId: s.ws, userId: s.owner, title: "u", titleSource: "auto", status: "active",
        pinned: false, model: "anthropic/claude-sonnet-5", nextSeq: 1, messageCount: 0,
        tokensIn: 0, tokensOut: 0, lastMessageAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
      }),
    );
    await t.withIdentity(as(s.owner)).mutation(api.chat.messages.send, {
      threadId: s.threadId,
      content: "Use Context7 to look up React hooks",
      clientId: "c1",
    });
    const thread = await t.run((ctx) => ctx.db.get(s.threadId));
    expect(thread?.mcpActivated).toEqual(["context7"]);
    const untouched = await t.run((ctx) => ctx.db.get(other));
    expect(untouched?.mcpActivated).toBeUndefined();
  });

  test("a successful MCP execution activates its connector", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // A stream for the thread, as dispatch would create one.
    const streamId = "stream-1";
    await t.run(async (ctx) => {
      const messageId = await ctx.db.insert("chatMessages", {
        threadId: s.threadId, workspaceId: s.ws, userId: s.owner, role: "assistant", seq: 1,
        content: "", status: "streaming", createdAt: Date.now(), updatedAt: Date.now(),
      });
      await ctx.db.insert("chatStreams", {
        streamId,
        messageId,
        threadId: s.threadId,
        workspaceId: s.ws,
        userId: s.owner,
        status: "running",
        cancelRequested: false,
        chunkSeq: -1,
        committedText: "",
        committedSeq: -1,
        heartbeatAt: Date.now(),
        startedAt: Date.now(),
        attempts: 0,
        deadlineAt: Date.now() + 300_000,
        hasEvents: false,
      });
    });
    const base = {
      streamId, executionId: "e1", stepId: "s1", toolCallId: "c1",
      toolId: "mcp:qa-redteam:read_ok", attemptId: "a1", attempt: 0,
      actionType: "tool", sideEffect: "read_only", inputHash: "h", createdAt: Date.now(),
    };
    const { internal } = await import("./_generated/api");
    await t.mutation(internal.chat.executions.upsertExecution, { ...base, state: "running" });
    await t.mutation(internal.chat.executions.upsertExecution, { ...base, state: "succeeded" });
    const thread = await t.run((ctx) => ctx.db.get(s.threadId));
    expect(thread?.mcpActivated).toEqual(["qa-redteam"]);
  });
});
