/// <reference types="vite/client" />
import { createHash } from "node:crypto";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;
const SECRET = "test-ingress-secret-0123456789ab";

async function seed(t: TestT, streamId = `stream_${Math.random()}`) {
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

// Mimics the Python `bound_for_row` envelope shape the /ai/ingress `report` op maps.
function envelope(
  reportId: string,
  streamId: string,
  status = "completed",
  manifest: unknown[] = [],
) {
  return {
    report_id: reportId,
    source_run_id: streamId,
    target: "https://example.com",
    scope: { type: "site" },
    status,
    generated_at: "2026-08-26T10:00:00Z",
    methodology: { name: "OllaSuper SEO Methodology", version: "1.0.0+checks.32" },
    summary: {
      total_findings: 4,
      passed: 1,
      failed: 1,
      warnings: 1,
      not_tested: 1,
    },
    findings: [
      { check_id: "crawl_index.robots_blocks_important", status: "FAIL" },
    ],
    manifest: { artifacts: manifest },
  };
}

async function upsert(
  t: TestT,
  streamId: string,
  reportId: string,
  status = "completed",
  manifest: {
    artifactId: string;
    format: string;
    mime: string;
    size: number;
    sha256: string;
  }[] = [],
) {
  return t.run((ctx) =>
    ctx.runMutation(internal.chat.reports.upsertReport, {
      streamId,
      reportId,
      status,
      target: "https://example.com",
      scope: "site",
      methodologyName: "OllaSuper SEO Methodology",
      methodologyVersion: "1.0.0+checks.32",
      generatedAt: "2026-08-26T10:00:00Z",
      summary: { totalFindings: 4, passed: 1, failed: 1, warnings: 1, notTested: 1 },
      report: JSON.stringify(envelope(reportId, streamId, status, manifest)),
      manifest,
    }),
  );
}

describe("chat SEO reports — persistence + ownership", () => {
  test("owner upsert → getReport round-trip (parsed report + manifest, no storageId)", async () => {
    const t = convexTest(schema, modules);
    const { streamId, userId } = await seed(t);
    await upsert(t, streamId, "rpt_a", "completed", [
      { artifactId: "art1", format: "json", mime: "application/json", size: 10, sha256: "abc" },
    ]);
    const got = await t
      .withIdentity(as(userId))
      .query(api.chat.reports.getReport, { reportId: "rpt_a" });
    expect(got.status).toBe("completed");
    expect(got.target).toBe("https://example.com");
    expect(got.manifest[0]?.artifactId).toBe("art1");
    // The parsed envelope is returned for the card.
    expect((got.report as { findings: unknown[] }).findings.length).toBe(1);
    // No storageId anywhere in the client-visible payload.
    expect(JSON.stringify(got)).not.toContain("storageId");
  });

  test("partial and failed statuses round-trip", async () => {
    const t = convexTest(schema, modules);
    const { streamId, userId } = await seed(t);
    await upsert(t, streamId, "rpt_partial", "partial");
    await upsert(t, streamId, "rpt_failed", "failed");
    const u = t.withIdentity(as(userId));
    expect((await u.query(api.chat.reports.getReport, { reportId: "rpt_partial" })).status).toBe("partial");
    expect((await u.query(api.chat.reports.getReport, { reportId: "rpt_failed" })).status).toBe("failed");
  });

  test("a non-owner cannot read a report (no existence oracle)", async () => {
    const t = convexTest(schema, modules);
    const { streamId, otherId } = await seed(t);
    await upsert(t, streamId, "rpt_secret");
    await expect(
      t.withIdentity(as(otherId)).query(api.chat.reports.getReport, { reportId: "rpt_secret" }),
    ).rejects.toThrow("Not found");
  });

  test("a missing report id is Not found (same as not-owned)", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await seed(t);
    await expect(
      t.withIdentity(as(userId)).query(api.chat.reports.getReport, { reportId: "nope" }),
    ).rejects.toThrow("Not found");
  });

  test("upsert is idempotent by (sourceRunId, reportId) — resume re-emit replaces, no dup", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seed(t);
    await upsert(t, streamId, "rpt_x", "partial");
    await upsert(t, streamId, "rpt_x", "completed"); // resume re-emit with newer status
    const rows = await t.run((ctx) =>
      ctx.db.query("seoReports").withIndex("by_report_id", (q) => q.eq("reportId", "rpt_x")).collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("completed");
  });

  test("owner is the runner: report ownership survives a workspace-role change", async () => {
    const t = convexTest(schema, modules);
    const { streamId, threadId, userId, otherId } = await seed(t);
    await upsert(t, streamId, "rpt_o");
    // Add the peer to the workspace as a member; chat is USER-scoped, so they still
    // cannot read the owner's report.
    await t.run(async (ctx) => {
      const thread = await ctx.db.get(threadId);
      await ctx.db.insert("members", {
        workspaceId: thread!.workspaceId,
        userId: otherId,
        role: "member",
        createdAt: Date.now(),
      });
    });
    await expect(
      t.withIdentity(as(otherId)).query(api.chat.reports.getReport, { reportId: "rpt_o" }),
    ).rejects.toThrow("Not found");
    // The owner still reads it.
    expect((await t.withIdentity(as(userId)).query(api.chat.reports.getReport, { reportId: "rpt_o" })).status).toBe("completed");
  });

  test("concurrent streams on one thread produce distinct, correctly-owned reports", async () => {
    const t = convexTest(schema, modules);
    const s1 = await seed(t, "stream_one");
    // A second concurrent stream on the SAME thread/message/user.
    await t.run(async (ctx) => {
      const thread = await ctx.db.get(s1.threadId);
      await ctx.db.insert("chatStreams", {
        streamId: "stream_two",
        messageId: s1.messageId,
        threadId: s1.threadId,
        workspaceId: thread!.workspaceId,
        userId: thread!.userId,
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
    });
    await upsert(t, "stream_one", "rpt_1");
    await upsert(t, "stream_two", "rpt_2");
    const rows = await t.run((ctx) => ctx.db.query("seoReports").collect());
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.userId === s1.userId)).toBe(true);
  });
});

describe("chat SEO reports — cascade cleanup", () => {
  test("purging the thread deletes report rows", async () => {
    const t = convexTest(schema, modules);
    const { streamId, threadId } = await seed(t);
    await upsert(t, streamId, "rpt_del");
    await t.run((ctx) => ctx.db.patch(threadId, { status: "trashed" }));
    await t.mutation(internal.chat.threads.purge, { threadId });
    const rows = await t.run((ctx) => ctx.db.query("seoReports").collect());
    expect(rows.length).toBe(0);
  });

  test("tail-purging a message deletes its report + generated artifacts", async () => {
    const t = convexTest(schema, modules);
    const { streamId, threadId } = await seed(t);
    await upsert(t, streamId, "rpt_msg");
    // Also register an artifact tied to the same stream/message.
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["X"], { type: "application/json" })),
    );
    await t.run((ctx) =>
      ctx.runMutation(internal.chat.artifacts.registerArtifact, {
        streamId,
        storageId,
        filename: "r.json",
        format: "json",
        mime: "application/json",
        size: 1,
      }),
    );
    await t.mutation(internal.chat.messages.purgeTail, { threadId, fromSeq: 2 });
    expect((await t.run((ctx) => ctx.db.query("seoReports").collect())).length).toBe(0);
    expect((await t.run((ctx) => ctx.db.query("chatArtifacts").collect())).length).toBe(0);
    const blobGone = await t.run(async (ctx) => (await ctx.storage.get(storageId)) === null);
    expect(blobGone).toBe(true);
  });
});

describe("artifact integrity + idempotency (registerArtifact)", () => {
  test("re-store with the same artifactKey returns one row + drops the dup blob", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seed(t);
    const mk = () =>
      t.run((ctx) => ctx.storage.store(new Blob(["Y"], { type: "text/plain" })));
    const register = (storageId: Id<"_storage">) =>
      t.run((ctx) =>
        ctx.runMutation(internal.chat.artifacts.registerArtifact, {
          streamId,
          storageId,
          filename: "r.json",
          format: "json",
          mime: "application/json",
          size: 1,
          contentHash: "hash1",
          artifactKey: "rpt_k:json",
        }),
      );
    const s1 = await mk();
    const first = await register(s1);
    const s2 = await mk();
    const second = await register(s2); // same artifactKey → idempotent
    expect(second.artifactId).toBe(first.artifactId);
    const rows = await t.run((ctx) => ctx.db.query("chatArtifacts").collect());
    expect(rows.length).toBe(1);
    // The duplicate blob was reclaimed; the first is retained.
    expect(await t.run(async (ctx) => (await ctx.storage.get(s2)) === null)).toBe(true);
    expect(await t.run(async (ctx) => (await ctx.storage.get(s1)) !== null)).toBe(true);
  });
});

describe("/ai/artifact checksum verification + /ai/ingress report op", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.AI_INGRESS_SECRET;
    process.env.AI_INGRESS_SECRET = SECRET;
  });
  afterEach(() => {
    if (prev === undefined) {
      // biome-ignore lint/performance/noDelete: the only way to unset an env var
      delete process.env.AI_INGRESS_SECRET;
    } else {
      process.env.AI_INGRESS_SECRET = prev;
    }
  });

  const postArtifact = (t: TestT, streamId: string, bytes: string, sha256?: string) =>
    t.fetch("/ai/artifact", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ai-key": SECRET,
        "x-stream-id": streamId,
        "x-artifact-format": "json",
        "x-artifact-filename": "r.json",
        ...(sha256 ? { "x-artifact-sha256": sha256 } : {}),
      },
      body: bytes,
    });

  test("a correct SHA-256 stores; a wrong one is rejected 422 and stores nothing", async () => {
    const t = convexTest(schema, modules);
    const { streamId } = await seed(t);
    const bytes = '{"ok":true}';
    const good = createHash("sha256").update(bytes).digest("hex");

    const okRes = await postArtifact(t, streamId, bytes, good);
    expect(okRes.status).toBe(200);

    const badRes = await postArtifact(t, streamId, bytes, "deadbeef");
    expect(badRes.status).toBe(422);
    // Only the good upload was stored.
    const rows = await t.run((ctx) => ctx.db.query("chatArtifacts").collect());
    expect(rows.length).toBe(1);
    expect(rows[0]?.contentHash).toBe(good);
  });

  test("op:report persists a report the owner can then read", async () => {
    const t = convexTest(schema, modules);
    const { streamId, userId } = await seed(t);
    const res = await t.fetch("/ai/ingress", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-key": SECRET },
      body: JSON.stringify({
        op: "report",
        streamId,
        report: envelope("rpt_http", streamId, "completed", [
          { artifact_id: "aX", format: "json", mime: "application/json", size: 5, sha256: "z" },
        ]),
      }),
    });
    expect(res.status).toBe(200);
    const got = await t
      .withIdentity(as(userId))
      .query(api.chat.reports.getReport, { reportId: "rpt_http" });
    expect(got.status).toBe("completed");
    expect(got.manifest[0]?.artifactId).toBe("aX");
  });

  test("op:report on an unknown stream is 404; a bad body is 400", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const unknown = await t.fetch("/ai/ingress", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-key": SECRET },
      body: JSON.stringify({ op: "report", streamId: "no_such_stream", report: envelope("r", "no_such_stream") }),
    });
    expect(unknown.status).toBe(404);
    const bad = await t.fetch("/ai/ingress", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-key": SECRET },
      body: JSON.stringify({ op: "report", streamId: "s", report: { no_report_id: true } }),
    });
    expect(bad.status).toBe(400);
  });
});
