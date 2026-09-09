/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Phase 8 — the audit read boundary.
 *
 * `audit.recent` is a PUBLIC query whose docstring said "the current user's
 * recent audit entries" while the handler read `by_workspace` with no user
 * filter. Any member of a workspace therefore received the last 50 rows for
 * EVERY member of it, with no elevated role required.
 *
 * It surfaced through custom skills — whose rows carried the skill NAME while
 * the Settings page promised "Private to you" — but the shape was general: this
 * was the read side of every audited action in the product.
 *
 * Both halves are asserted here: the row no longer carries the name, AND the
 * query no longer serves other people's rows. Either fix alone would leave the
 * other class of leak standing.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

/** Two users who SHARE one workspace — the case the boundary must hold for. */
async function seed(t: TestT) {
  return t.run(async (ctx) => {
    const alice = await ctx.db.insert("users", { email: "alice@t.test" });
    const bob = await ctx.db.insert("users", { email: "bob@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: alice,
      createdAt: Date.now(),
    });
    for (const [u, role] of [
      [alice, "owner"],
      [bob, "member"],
    ] as const) {
      await ctx.db.insert("members", {
        workspaceId,
        userId: u,
        role,
        createdAt: Date.now(),
      });
    }
    return { alice, bob, workspaceId };
  });
}

const PRIVATE_NAME = "Draft my resignation letter";

async function aliceCreatesASkill(
  t: TestT,
  alice: Id<"users">,
  workspaceId: Id<"workspaces">,
) {
  return t.withIdentity(as(alice)).mutation(api.userSkills.create, {
    workspaceId,
    name: PRIVATE_NAME,
    description: "Personal.",
    instructions: "Be firm but polite.",
  });
}

describe("a peer cannot read another user's audit trail", () => {
  test("Bob does not receive Alice's rows from the same workspace", async () => {
    const t = convexTest(schema, modules);
    const { alice, bob, workspaceId } = await seed(t);
    await aliceCreatesASkill(t, alice, workspaceId);

    const bobSees = await t
      .withIdentity(as(bob))
      .query(api.audit.recent, { workspaceId });
    expect(bobSees.every((r) => r.userId === bob)).toBe(true);
    expect(bobSees.map((r) => r.action)).not.toContain("skill.create");
  });

  test("Alice still sees her own", async () => {
    // The fix must not blind a user to their own trail.
    const t = convexTest(schema, modules);
    const { alice, workspaceId } = await seed(t);
    await aliceCreatesASkill(t, alice, workspaceId);

    const aliceSees = await t
      .withIdentity(as(alice))
      .query(api.audit.recent, { workspaceId });
    expect(aliceSees.map((r) => r.action)).toContain("skill.create");
    expect(aliceSees.every((r) => r.userId === alice)).toBe(true);
  });

  test("the private NAME is nowhere in the audit trail at all", async () => {
    // Belt and braces: even the owner's own rows do not carry it, so a future
    // widening of the read cannot re-open this.
    const t = convexTest(schema, modules);
    const { alice, workspaceId } = await seed(t);
    const id = await aliceCreatesASkill(t, alice, workspaceId);
    const me = t.withIdentity(as(alice));
    await me.mutation(api.userSkills.update, {
      skillId: id,
      name: PRIVATE_NAME,
      description: "Personal.",
      instructions: "Be firm but polite.",
    });
    await me.mutation(api.userSkills.setEnabled, { skillId: id, enabled: false });
    await me.mutation(api.userSkills.remove, { skillId: id });

    const rows = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(rows)).not.toContain(PRIVATE_NAME);
    // The id is still there, so the trail still says WHICH skill changed.
    expect(JSON.stringify(rows)).toContain(id);
  });

  test("a non-member is refused before any row is read", async () => {
    const t = convexTest(schema, modules);
    const { alice, workspaceId } = await seed(t);
    await aliceCreatesASkill(t, alice, workspaceId);
    const outsider = await t.run((ctx) =>
      ctx.db.insert("users", { email: "outsider@t.test" }),
    );
    await expect(
      t.withIdentity(as(outsider)).query(api.audit.recent, { workspaceId }),
    ).rejects.toThrow();
  });

  test("signed out returns nothing rather than throwing", async () => {
    // A rejected query logs console.error, and every e2e script asserts zero.
    const t = convexTest(schema, modules);
    const { workspaceId } = await seed(t);
    expect(await t.query(api.audit.recent, { workspaceId })).toEqual([]);
  });
});
