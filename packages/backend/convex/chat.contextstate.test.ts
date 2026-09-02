/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { loadContext } from "./chat/context";
import schema from "./schema";

/**
 * The authoritative state layer: artifacts, lineage, and the derived floor.
 *
 * THE POINT OF EVERY TEST HERE is that the floor is a PURE FUNCTION of rows the
 * application owns. Nothing below writes a model-supplied value and then reads
 * it back — that would be the original bug in a new hat, where the thing a
 * follow-up resolves against is whatever something else last remembered to say.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

type Seed = {
  threadId: Id<"chatThreads">;
  userId: Id<"users">;
  workspaceId: Id<"workspaces">;
  nextSeq: number;
};

async function seedThread(t: ReturnType<typeof convexTest>): Promise<Seed> {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "u@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
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
      nextSeq: 0,
      messageCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { threadId, userId, workspaceId, nextSeq: 0 };
  });
}

/** One assistant turn, with the stream the ingress ops are keyed on. */
async function turn(
  t: ReturnType<typeof convexTest>,
  s: Seed,
  opts: { role?: "user" | "assistant"; content: string; seq: number },
): Promise<string> {
  const streamId = `stream_${opts.seq}_${Math.random().toString(36).slice(2)}`;
  await t.run(async (ctx) => {
    const messageId = await ctx.db.insert("chatMessages", {
      threadId: s.threadId,
      userId: s.userId,
      workspaceId: s.workspaceId,
      role: opts.role ?? "assistant",
      content: opts.content,
      seq: opts.seq,
      status: "complete",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("chatStreams", {
      streamId,
      messageId,
      threadId: s.threadId,
      workspaceId: s.workspaceId,
      userId: s.userId,
      status: "done",
      cancelRequested: false,
      chunkSeq: 0,
      committedText: opts.content,
      committedSeq: 0,
      heartbeatAt: Date.now(),
      startedAt: Date.now(),
    });
  });
  return streamId;
}

const read = (t: ReturnType<typeof convexTest>, s: Seed) =>
  t.run(async (ctx) => loadContext(ctx, s.threadId));

describe("artifact identity and lineage", () => {
  test("a produced turn becomes an addressable v1", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const streamId = await turn(t, s, { content: "THE BLOG", seq: 1 });

    const res = await t.mutation(internal.chat.context.registerArtifact, {
      streamId,
      kind: "blog",
      subject: "Cloud WireGuard VPN",
    });
    expect(res.ok).toBe(true);

    const ctx = await read(t, s);
    expect(ctx.activeArtifactId).toBe(res.artifactId);
    expect(ctx.activeArtifactVersion).toBe(1);
    expect(ctx.activeSubject).toBe("Cloud WireGuard VPN");
  });

  test("a superseding turn makes v2 and demotes v1 — one active head, always", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const first = await turn(t, s, { content: "v1 body", seq: 1 });
    const created = await t.mutation(internal.chat.context.registerArtifact, {
      streamId: first,
      kind: "blog",
      subject: "Cloud WireGuard VPN",
    });

    const second = await turn(t, s, { content: "v2 body", seq: 3 });
    const updated = await t.mutation(internal.chat.context.registerArtifact, {
      streamId: second,
      kind: "blog",
      subject: "Cloud WireGuard VPN",
      supersedesArtifactId: created.artifactId,
    });
    expect(updated.version).toBe(2);
    expect(updated.artifactId).toBe(created.artifactId);

    const ctx = await read(t, s);
    // Exactly one active head. Two would make every bare reference ambiguous.
    const actives = ctx.artifacts.filter((a) => a.status === "active");
    expect(actives).toHaveLength(1);
    expect(actives[0].version).toBe(2);
    expect(ctx.activeArtifactVersion).toBe(2);
  });

  test("registering the same version twice does not fork the lineage", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const streamId = await turn(t, s, { content: "body", seq: 1 });

    const a = await t.mutation(internal.chat.context.registerArtifact, {
      streamId,
      kind: "blog",
      subject: "S",
    });
    // A retried finalize, a duplicate ingress, or a crash-resume.
    const b = await t.mutation(internal.chat.context.registerArtifact, {
      streamId,
      kind: "blog",
      subject: "S",
      supersedesArtifactId: a.artifactId,
    });

    expect(b.artifactId).toBe(a.artifactId);
    const ctx = await read(t, s);
    expect(ctx.artifacts).toHaveLength(1);
    expect(ctx.activeArtifactVersion).toBe(1);
  });

  test("revert walks the lineage, not the transcript", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const s1 = await turn(t, s, { content: "v1", seq: 1 });
    const made = await t.mutation(internal.chat.context.registerArtifact, {
      streamId: s1,
      kind: "blog",
      subject: "S",
    });
    const s2 = await turn(t, s, { content: "v2", seq: 3 });
    await t.mutation(internal.chat.context.registerArtifact, {
      streamId: s2,
      kind: "blog",
      subject: "S",
      supersedesArtifactId: made.artifactId,
    });

    const s3 = await turn(t, s, { content: "revert turn", seq: 5 });
    // The mutation returns a union; narrow before reusing the id.
    if (!made.ok || !made.artifactId) throw new Error("registration failed");
    const rev = await t.mutation(internal.chat.context.revertArtifact, {
      streamId: s3,
      artifactId: made.artifactId,
    });
    expect(rev.ok).toBe(true);
    expect(rev.version).toBe(1);

    const ctx = await read(t, s);
    expect(ctx.activeArtifactVersion).toBe(1);
    expect(ctx.artifacts.filter((a) => a.status === "active")).toHaveLength(1);
  });
});

describe("the derived floor", () => {
  test("entity ACTIVATION order, not mention order", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);

    const pg = await turn(t, s, { content: "postgres article", seq: 1 });
    await t.mutation(internal.chat.context.registerArtifact, {
      streamId: pg,
      kind: "report",
      subject: "PostgreSQL",
    });
    const redis = await turn(t, s, { content: "redis article", seq: 3 });
    await t.mutation(internal.chat.context.registerArtifact, {
      streamId: redis,
      kind: "report",
      subject: "Redis",
    });

    // The user goes back. This is the whole point: Redis was produced later,
    // but PostgreSQL is what the conversation is now about.
    await turn(t, s, {
      role: "user",
      content: "go back to PostgreSQL",
      seq: 5,
    });

    const ctx = await read(t, s);
    expect(ctx.entities[0].name).toBe("PostgreSQL");
    expect(ctx.entities[0].activatedAtSeq).toBe(5);
  });

  test("an assistant mention does NOT re-activate a subject", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const pg = await turn(t, s, { content: "postgres", seq: 1 });
    await t.mutation(internal.chat.context.registerArtifact, {
      streamId: pg,
      kind: "report",
      subject: "PostgreSQL",
    });
    const redis = await turn(t, s, { content: "redis", seq: 3 });
    await t.mutation(internal.chat.context.registerArtifact, {
      streamId: redis,
      kind: "report",
      subject: "Redis",
    });
    // The assistant mentions PostgreSQL in passing while working on Redis.
    await turn(t, s, {
      role: "assistant",
      content: "Redis differs from PostgreSQL in that ...",
      seq: 5,
    });

    const ctx = await read(t, s);
    // Redis is still what is being worked on.
    expect(ctx.entities[0].name).toBe("Redis");
  });

  test("the artifact text rides along only when it fell out of the window", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const streamId = await turn(t, s, { content: "ANCIENT BODY", seq: 1 });
    await t.mutation(internal.chat.context.registerArtifact, {
      streamId,
      kind: "blog",
      subject: "S",
    });

    const inWindow = await t.run(async (ctx) =>
      loadContext(ctx, s.threadId, new Set([1])),
    );
    expect(inWindow.activeArtifactText).toBeNull();

    const outOfWindow = await t.run(async (ctx) =>
      loadContext(ctx, s.threadId, new Set([99])),
    );
    expect(outOfWindow.activeArtifactText).toBe("ANCIENT BODY");
  });
});

describe("state writes cannot go backwards", () => {
  test("a stale write is refused, a newer one applies", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const a = await turn(t, s, { content: "x", seq: 5 });

    await t.mutation(internal.chat.context.applyContextWrite, {
      streamId: a,
      throughSeq: 5,
      operation: "MODIFY",
      userConstraints: ["technically accurate"],
    });

    // A slow/retried turn for OLDER messages must not roll the state back.
    const stale = await t.mutation(internal.chat.context.applyContextWrite, {
      streamId: a,
      throughSeq: 2,
      operation: "CREATE",
    });
    expect(stale.stale).toBe(true);

    const ctx = await read(t, s);
    expect(ctx.lastOperation).toBe("MODIFY");
    expect(ctx.userConstraints).toEqual(["technically accurate"]);
  });

  test("an absent enrichment field leaves the stored value standing", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const a = await turn(t, s, { content: "x", seq: 1 });

    await t.mutation(internal.chat.context.applyContextWrite, {
      streamId: a,
      throughSeq: 1,
      userConstraints: ["SEO-friendly", "publish-ready"],
    });
    // A later turn that says nothing about constraints must not erase them —
    // "make it more human" must not silently drop the SEO requirement.
    await t.mutation(internal.chat.context.applyContextWrite, {
      streamId: a,
      throughSeq: 2,
      operation: "REWRITE",
    });

    const ctx = await read(t, s);
    expect(ctx.userConstraints).toEqual(["SEO-friendly", "publish-ready"]);
    expect(ctx.lastOperation).toBe("REWRITE");
  });
});

describe("the floor survives a model that records nothing", () => {
  /**
   * The requirement that everything else hangs off: authoritative state must not
   * depend on model cooperation. No applyContextWrite is called at all here.
   */
  test("artifact, version and subject are all present with zero enrichment", async () => {
    const t = convexTest(schema, modules);
    const s = await seedThread(t);
    const s1 = await turn(t, s, { content: "body v1", seq: 1 });
    const made = await t.mutation(internal.chat.context.registerArtifact, {
      streamId: s1,
      kind: "blog",
      subject: "Cloud WireGuard VPN",
    });
    const s2 = await turn(t, s, { content: "body v2", seq: 3 });
    await t.mutation(internal.chat.context.registerArtifact, {
      streamId: s2,
      kind: "blog",
      subject: "Cloud WireGuard VPN",
      supersedesArtifactId: made.artifactId,
    });

    const ctx = await read(t, s);
    expect(ctx.activeArtifactId).toBe(made.artifactId);
    expect(ctx.activeArtifactVersion).toBe(2);
    expect(ctx.activeSubject).toBe("Cloud WireGuard VPN");
    expect(ctx.entities[0].name).toBe("Cloud WireGuard VPN");
    // ...and the enrichment fields are simply empty, not wrong.
    expect(ctx.userConstraints).toEqual([]);
    expect(ctx.lastOperation).toBeNull();
  });
});
