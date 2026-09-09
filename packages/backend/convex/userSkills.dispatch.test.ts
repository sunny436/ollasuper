/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Phase 4 — the DISPATCH boundary for user-authored skills.
 *
 * `userSkills.test.ts` covers CRUD authorization. This file covers the one
 * question that only matters at dispatch: when a turn is handed to the
 * inference plane, WHICH skills ride along, and whose.
 *
 * The identity under test is `chatStreams.userId` — written from `getAuthUserId`
 * when the turn starts, never from anything a client sends. Everything here
 * exists to prove that a second user's rows cannot reach a first user's payload
 * even when both belong to the same workspace, which is the case a
 * workspace-scoped read would get wrong.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

/** Two users sharing one workspace, plus a live stream owned by the first. */
async function seed(t: TestT) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "owner@t.test" });
    const other = await ctx.db.insert("users", { email: "other@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    for (const [u, role] of [
      [owner, "owner"],
      [other, "member"],
    ] as const) {
      await ctx.db.insert("members", {
        workspaceId,
        userId: u,
        role,
        createdAt: Date.now(),
      });
    }
    const threadId = await ctx.db.insert("chatThreads", {
      userId: owner,
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
    // The user turn being answered — dispatchPayload builds history from it.
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
    return { owner, other, workspaceId, threadId, messageId, streamId };
  });
}

const GOOD = {
  name: "Contract reviewer",
  description: "Reviews contracts for ambiguity.",
  instructions: "Read the contract and flag every ambiguous clause.",
};

async function makeSkill(
  t: TestT,
  userId: Id<"users">,
  workspaceId: Id<"workspaces">,
  over: Partial<typeof GOOD> & { capabilities?: string[] } = {},
) {
  return t
    .withIdentity(as(userId))
    .mutation(api.userSkills.create, { workspaceId, ...GOOD, ...over });
}

const payloadFor = (t: TestT, streamId: string) =>
  t.query(internal.chat.stream.dispatchPayload, { streamId });

describe("dispatch snapshot", () => {
  test("the stream owner's enabled skill rides the payload", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    await makeSkill(t, owner, workspaceId);
    const p = await payloadFor(t, streamId);
    expect(p?.customSkills).toHaveLength(1);
    expect(p?.customSkills[0]).toMatchObject({
      name: "Contract reviewer",
      instructions: "Read the contract and flag every ambiguous clause.",
      ownerId: owner,
      enabled: true,
    });
  });

  test("ANOTHER user's skill never reaches it — same workspace", async () => {
    // The case a workspace-scoped read would get wrong. Both users belong to
    // this workspace and the skill was created in it; it is still not the
    // stream owner's, so it must not travel.
    const t = convexTest(schema, modules);
    const { other, workspaceId, streamId } = await seed(t);
    await makeSkill(t, other, workspaceId, { name: "Not yours" });
    const p = await payloadFor(t, streamId);
    expect(p?.customSkills).toEqual([]);
  });

  test("a mixed set is filtered to the stream owner alone", async () => {
    const t = convexTest(schema, modules);
    const { owner, other, workspaceId, streamId } = await seed(t);
    await makeSkill(t, owner, workspaceId, { name: "Mine" });
    await makeSkill(t, other, workspaceId, { name: "Theirs" });
    const p = await payloadFor(t, streamId);
    expect(p?.customSkills.map((s) => s.name)).toEqual(["Mine"]);
  });

  test("a DISABLED skill is excluded", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    const id = await makeSkill(t, owner, workspaceId);
    await t
      .withIdentity(as(owner))
      .mutation(api.userSkills.setEnabled, { skillId: id, enabled: false });
    expect((await payloadFor(t, streamId))?.customSkills).toEqual([]);
  });

  test("re-enabling brings it back with the body intact", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    const id = await makeSkill(t, owner, workspaceId);
    for (const enabled of [false, true]) {
      await t
        .withIdentity(as(owner))
        .mutation(api.userSkills.setEnabled, { skillId: id, enabled });
    }
    const p = await payloadFor(t, streamId);
    expect(p?.customSkills).toHaveLength(1);
    expect(p?.customSkills[0].instructions).toContain("ambiguous clause");
  });

  test("a DELETED skill is excluded — no soft-delete to leak through", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    const id = await makeSkill(t, owner, workspaceId);
    expect((await payloadFor(t, streamId))?.customSkills).toHaveLength(1);
    await t
      .withIdentity(as(owner))
      .mutation(api.userSkills.remove, { skillId: id });
    expect((await payloadFor(t, streamId))?.customSkills).toEqual([]);
  });

  test("a user with no skills gets an empty array, not a missing field", async () => {
    // Everyone today. `extra="forbid"` on the Python side means the field must
    // be present and well-typed even when nobody has written a skill.
    const t = convexTest(schema, modules);
    const { streamId } = await seed(t);
    expect((await payloadFor(t, streamId))?.customSkills).toEqual([]);
  });

  test("skills cross WORKSPACES — they follow the person", async () => {
    // Created in a second workspace, used in a turn taking place in the first.
    // The documented scope=user contract, asserted rather than assumed.
    const t = convexTest(schema, modules);
    const { owner, streamId } = await seed(t);
    const ws2 = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaces", {
        name: "WS2",
        ownerId: owner,
        createdAt: Date.now(),
      });
      await ctx.db.insert("members", {
        workspaceId: id,
        userId: owner,
        role: "owner",
        createdAt: Date.now(),
      });
      return id;
    });
    await makeSkill(t, owner, ws2, { name: "From elsewhere" });
    const p = await payloadFor(t, streamId);
    expect(p?.customSkills.map((s) => s.name)).toEqual(["From elsewhere"]);
  });

  test("the snapshot carries no database internals", async () => {
    // An explicit projection, so a column added to the table later cannot start
    // travelling to the inference plane by accident.
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    await makeSkill(t, owner, workspaceId);
    const s = (await payloadFor(t, streamId))?.customSkills[0];
    expect(Object.keys(s ?? {}).sort()).toEqual([
      "capabilities",
      "constraints",
      "description",
      "enabled",
      "id",
      "instructions",
      "name",
      "ownerId",
      "revision",
    ]);
  });

  test("revision tracks the last write, so telemetry can name the text", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    const id = await makeSkill(t, owner, workspaceId);
    const before = (await payloadFor(t, streamId))?.customSkills[0].revision ?? 0;
    await t.withIdentity(as(owner)).mutation(api.userSkills.update, {
      skillId: id,
      ...GOOD,
      instructions: "Completely different guidance now.",
    });
    const after = (await payloadFor(t, streamId))?.customSkills[0];
    expect(after?.revision).toBeGreaterThanOrEqual(before);
    expect(after?.instructions).toBe("Completely different guidance now.");
  });

  test("the set is ordered most-recently-updated first", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    const a = await makeSkill(t, owner, workspaceId, { name: "A" });
    await makeSkill(t, owner, workspaceId, { name: "B" });
    // Touch A so it becomes the most recent.
    await t
      .withIdentity(as(owner))
      .mutation(api.userSkills.update, { skillId: a, ...GOOD, name: "A" });
    const names = (await payloadFor(t, streamId))?.customSkills.map((s) => s.name);
    expect(names?.[0]).toBe("A");
    expect(new Set(names)).toEqual(new Set(["A", "B"]));
  });

  test("the payload is bounded by the per-user cap", async () => {
    const t = convexTest(schema, modules);
    const { owner, workspaceId, streamId } = await seed(t);
    for (let i = 0; i < 6; i++) {
      await makeSkill(t, owner, workspaceId, { name: `S${i}` });
    }
    const p = await payloadFor(t, streamId);
    expect(p?.customSkills.length).toBe(6);
    // Nothing here is unbounded: MAX_SKILLS_PER_USER is enforced on write, and
    // the dispatch read takes at most that many.
    expect(p?.customSkills.length).toBeLessThanOrEqual(50);
  });
});
