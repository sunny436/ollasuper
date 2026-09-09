/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Phase 7 — LIFECYCLE. What a skill edit means to a turn that is already going.
 *
 * The contract these tests pin down, stated once (and again in `userSkills.ts`):
 *
 *   * A run is already immutable. `dispatchPayload` ships skills BY VALUE and
 *     the runtime reads them once, so an edit cannot reach a generation that
 *     has started.
 *   * Across attempts, LATEST WINS. A retry or resume re-dispatches, so it sees
 *     current rows — the same rule `projectInstructions`, `memories` and
 *     `personalization` already follow on the same turn.
 *   * Nothing holds a reference, so a deleted skill cannot dangle.
 *
 * These tests assert the DISPATCH half of that. The "an in-flight run cannot
 * see the edit" half is a property of the Python runtime and is asserted in
 * tests/test_user_skills_lifecycle.py, because that is where it can be broken.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

const GOOD = {
  name: "Contract reviewer",
  description: "Reviews contracts for ambiguity.",
  instructions: "ORIGINAL: flag every ambiguous clause.",
};

async function seed(t: TestT, opts: { scheduled?: boolean } = {}) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId,
      userId: owner,
      role: "owner",
      createdAt: Date.now(),
    });

    let scheduledTaskId: Id<"scheduledTasks"> | undefined;
    if (opts.scheduled) {
      scheduledTaskId = await ctx.db.insert("scheduledTasks", {
        userId: owner,
        workspaceId,
        title: "Weekly report",
        prompt: "Summarise the week.",
        spec: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
        status: "active",
        revision: 1,
        cursorAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    const threadId = await ctx.db.insert("chatThreads", {
      userId: owner,
      workspaceId,
      ...(scheduledTaskId ? { scheduledTaskId } : {}),
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
    await ctx.db.insert("chatMessages", {
      threadId,
      userId: owner,
      workspaceId,
      role: "user",
      content: "Review this contract",
      seq: 1,
      status: "complete",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const messageId = await ctx.db.insert("chatMessages", {
      threadId,
      userId: owner,
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
      userId: owner,
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
    return { owner, workspaceId, threadId, messageId, streamId };
  });
}

const payload = (t: TestT, streamId: string) =>
  t.query(internal.chat.stream.dispatchPayload, { streamId });

const makeSkill = (
  t: TestT,
  owner: Id<"users">,
  workspaceId: Id<"workspaces">,
  over: Partial<typeof GOOD> = {},
) =>
  t
    .withIdentity(as(owner))
    .mutation(api.userSkills.create, { workspaceId, ...GOOD, ...over });

/** Mark the stream as a crash-resume, the way the reaper does. */
const markResuming = (t: TestT, streamId: string, attempts = 2) =>
  t.run(async (ctx) => {
    const s = await ctx.db
      .query("chatStreams")
      .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
      .unique();
    if (s) await ctx.db.patch(s._id, { attempts });
  });

describe("edit / disable / delete against a live turn", () => {
  test("an EDIT reaches the next dispatch, not the one already taken", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    const id = await makeSkill(t, owner, workspaceId);

    // The payload a running generation is holding.
    const inflight = await payload(t, streamId);
    expect(inflight?.customSkills[0].instructions).toContain("ORIGINAL");

    await t.withIdentity(as(owner)).mutation(api.userSkills.update, {
      skillId: id,
      ...GOOD,
      instructions: "EDITED: quote every clause number.",
    });

    // The value already handed out is a value — nothing rewrote it.
    expect(inflight?.customSkills[0].instructions).toContain("ORIGINAL");
    // And the next dispatch sees the edit.
    const next = await payload(t, streamId);
    expect(next?.customSkills[0].instructions).toContain("EDITED");
  });

  test("a DISABLE removes it from the next dispatch and nothing else", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    const id = await makeSkill(t, owner, workspaceId);
    expect((await payload(t, streamId))?.customSkills).toHaveLength(1);

    await t
      .withIdentity(as(owner))
      .mutation(api.userSkills.setEnabled, { skillId: id, enabled: false });
    expect((await payload(t, streamId))?.customSkills).toEqual([]);

    // Disabling IGNORES a skill; it never destroys it. Re-enabling restores the
    // body exactly, so a disable is not a lossy delete.
    await t
      .withIdentity(as(owner))
      .mutation(api.userSkills.setEnabled, { skillId: id, enabled: true });
    const back = await payload(t, streamId);
    expect(back?.customSkills[0].instructions).toContain("ORIGINAL");
  });

  test("a DELETE mid-turn leaves no dangling reference anywhere", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId, messageId } = await seed(t);
    const id = await makeSkill(t, owner, workspaceId);
    expect((await payload(t, streamId))?.customSkills).toHaveLength(1);

    await t
      .withIdentity(as(owner))
      .mutation(api.userSkills.remove, { skillId: id });

    // The turn still dispatches — a missing skill is an absence, never an error.
    const after = await payload(t, streamId);
    expect(after).not.toBeNull();
    expect(after?.customSkills).toEqual([]);
    // And the stream/message rows never referenced it in the first place.
    const rows = await t.run(async (ctx) => ({
      stream: await ctx.db
        .query("chatStreams")
        .withIndex("by_streamId", (q) => q.eq("streamId", streamId))
        .unique(),
      message: await ctx.db.get(messageId),
    }));
    expect(JSON.stringify(rows)).not.toContain(id);
  });
});

describe("retry and resume", () => {
  test("a RESUME re-reads and gets the latest content", async () => {
    // Deliberate: a resumed attempt is not reproducible with respect to
    // configuration, exactly as it is not for project instructions, memories or
    // personalization. Asserted so the choice cannot be lost by accident.
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    const id = await makeSkill(t, owner, workspaceId);
    await markResuming(t, streamId);

    await t.withIdentity(as(owner)).mutation(api.userSkills.update, {
      skillId: id,
      ...GOOD,
      instructions: "EDITED: quote every clause number.",
    });
    const resumed = await payload(t, streamId);
    expect(resumed?.attempt).toBeGreaterThan(0);
    expect(resumed?.customSkills[0].instructions).toContain("EDITED");
  });

  test("a RETRY after a DELETE simply carries no skills", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    const id = await makeSkill(t, owner, workspaceId);
    await markResuming(t, streamId, 1);
    await t
      .withIdentity(as(owner))
      .mutation(api.userSkills.remove, { skillId: id });
    const retried = await payload(t, streamId);
    expect(retried?.attempt).toBe(1);
    expect(retried?.customSkills).toEqual([]);
  });

  test("a skill change does not disturb the resume state itself", async () => {
    // The recovery machinery and the skill snapshot are independent. An edit
    // must not perturb attempt counting or the resume flags.
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    const id = await makeSkill(t, owner, workspaceId);
    await markResuming(t, streamId, 3);
    const before = await payload(t, streamId);
    await t
      .withIdentity(as(owner))
      .mutation(api.userSkills.setEnabled, { skillId: id, enabled: false });
    const after = await payload(t, streamId);
    for (const k of [
      "attempt",
      "completedSteps",
      "eventSeqBaseline",
      "unattended",
    ] as const) {
      expect(after?.[k]).toEqual(before?.[k]);
    }
  });
});

describe("scheduled execution", () => {
  test("a scheduled turn carries its OWNER's skills", async () => {
    // There is no task -> skill binding to pin: a task cannot name a skill.
    // Skills apply because the run belongs to their owner, so this is the same
    // content-freshness rule as chat, asserted where it is easiest to get wrong.
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t, { scheduled: true });
    await makeSkill(t, owner, workspaceId);
    const p = await payload(t, streamId);
    expect(p?.unattended).toBe(true);
    expect(p?.customSkills).toHaveLength(1);
    expect(p?.customSkills[0].instructions).toContain("ORIGINAL");
  });

  test("a disabled skill does not run in a scheduled task either", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t, { scheduled: true });
    const id = await makeSkill(t, owner, workspaceId);
    await t
      .withIdentity(as(owner))
      .mutation(api.userSkills.setEnabled, { skillId: id, enabled: false });
    const p = await payload(t, streamId);
    expect(p?.unattended).toBe(true);
    expect(p?.customSkills).toEqual([]);
  });
});

describe("audit and account deletion", () => {
  test("every lifecycle transition writes exactly one audit row", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId } = await seed(t);
    const id = await makeSkill(t, owner, workspaceId);
    const me = t.withIdentity(as(owner));
    await me.mutation(api.userSkills.update, { skillId: id, ...GOOD });
    await me.mutation(api.userSkills.setEnabled, { skillId: id, enabled: false });
    await me.mutation(api.userSkills.setEnabled, { skillId: id, enabled: true });
    await me.mutation(api.userSkills.remove, { skillId: id });

    const actions = await t.run(async (ctx) =>
      (await ctx.db.query("auditLogs").collect())
        .map((r) => r.action)
        .filter((a) => a.startsWith("skill.")),
    );
    expect(actions.sort()).toEqual([
      "skill.create",
      "skill.delete",
      "skill.disable",
      "skill.enable",
      "skill.update",
    ]);
  });

  test("an audit row never carries the skill body", async () => {
    // Audit rows are readable by any workspace member; a private skill's text is
    // not workspace data. The NAME is enough to say what happened.
    const t = convexTest(schema, modules);
    const { owner, workspaceId } = await seed(t);
    await makeSkill(t, owner, workspaceId, {
      instructions: "SECRETBODY do the thing",
    });
    const rows = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(JSON.stringify(rows)).not.toContain("SECRETBODY");
  });

  test("deleting the account takes the skills with it", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId } = await seed(t);
    for (let i = 0; i < 3; i++) {
      await makeSkill(t, owner, workspaceId, { name: `S${i}` });
    }
    expect(
      await t.run((ctx) => ctx.db.query("userSkills").collect()),
    ).toHaveLength(3);

    await t.mutation(internal.users.deleteUserAccount, { userId: owner });
    expect(await t.run((ctx) => ctx.db.query("userSkills").collect())).toEqual(
      [],
    );
  });
});
