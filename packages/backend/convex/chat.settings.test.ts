/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import {
  PERSONALIZATION_DEFAULTS,
  legacyStyleString,
} from "./chat/settings";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { email: "o@t.test" });
    const other = await ctx.db.insert("users", { email: "x@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: owner,
      createdAt: Date.now(),
    });
    for (const u of [owner, other]) {
      await ctx.db.insert("members", {
        workspaceId: ws,
        userId: u,
        role: u === owner ? "owner" : "member",
        createdAt: Date.now(),
      });
    }
    return { owner, other, ws };
  });
}

describe("personalization is canonical, scoped and resettable", () => {
  test("a user with no row reads the product defaults", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const got = await t
      .withIdentity(as(owner))
      .query(api.chat.settings.get, { workspaceId: ws });
    expect(got.personalization).toEqual(PERSONALIZATION_DEFAULTS);
  });

  test("a row written BEFORE this field existed reads as defaults", async () => {
    // The backward-compatibility guarantee: no migration, no backfill.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    await t.run((ctx) =>
      ctx.db.insert("chatSettings", {
        workspaceId: ws,
        userId: owner,
        defaultModel: "anthropic/claude-sonnet-5",
        sendOnEnter: true,
        updatedAt: Date.now(),
      }),
    );
    const got = await t
      .withIdentity(as(owner))
      .query(api.chat.settings.get, { workspaceId: ws });
    expect(got.personalization).toEqual(PERSONALIZATION_DEFAULTS);
  });

  test("save round-trips every field", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const wanted = {
      version: 1,
      enabled: true,
      baseStyle: "formal" as const,
      characteristics: ["warm" as const, "headers" as const],
      responseSpeed: "fast" as const,
      responseLanguage: "Spanish",
    };
    await t
      .withIdentity(as(owner))
      .mutation(api.chat.settings.upsert, {
        workspaceId: ws,
        personalization: wanted,
      });
    const got = await t
      .withIdentity(as(owner))
      .query(api.chat.settings.get, { workspaceId: ws });
    expect(got.personalization).toEqual(wanted);
  });

  test("the legacy prose string is DERIVED, never taken from the client", async () => {
    // It exists only so a rollback to a pre-canonical Python build still
    // styles replies; letting the client set it would let the two disagree.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    await t.withIdentity(as(owner)).mutation(api.chat.settings.upsert, {
      workspaceId: ws,
      customInstructionsStyle: "TOTALLY UNRELATED CLIENT TEXT",
      personalization: { ...PERSONALIZATION_DEFAULTS, baseStyle: "formal" },
    });
    const got = await t
      .withIdentity(as(owner))
      .query(api.chat.settings.get, { workspaceId: ws });
    expect(got.customInstructionsStyle).not.toContain("UNRELATED");
    expect(got.customInstructionsStyle).toContain("formal");
  });

  test("disabled compiles to no legacy style, and preferences are KEPT", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    await t.withIdentity(as(owner)).mutation(api.chat.settings.upsert, {
      workspaceId: ws,
      personalization: {
        ...PERSONALIZATION_DEFAULTS,
        enabled: false,
        baseStyle: "playful",
      },
    });
    const got = await t
      .withIdentity(as(owner))
      .query(api.chat.settings.get, { workspaceId: ws });
    expect(got.customInstructionsStyle).toBeNull();
    // Disabling IGNORES preferences; it must not delete them.
    expect(got.personalization.baseStyle).toBe("playful");
  });

  test("duplicate characteristics are collapsed", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    await t.withIdentity(as(owner)).mutation(api.chat.settings.upsert, {
      workspaceId: ws,
      personalization: {
        ...PERSONALIZATION_DEFAULTS,
        characteristics: ["warm", "warm", "emoji", "warm"],
      },
    });
    const got = await t
      .withIdentity(as(owner))
      .query(api.chat.settings.get, { workspaceId: ws });
    expect(got.personalization.characteristics.sort()).toEqual(["emoji", "warm"]);
  });

  test("an unknown style or characteristic is refused by the validator", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    // biome-ignore lint/suspicious/noExplicitAny: the point is invalid input
    const badStyle = { ...PERSONALIZATION_DEFAULTS, baseStyle: "sudo" } as any;
    const traits = { ...PERSONALIZATION_DEFAULTS, characteristics: ["root"] };
    // biome-ignore lint/suspicious/noExplicitAny: the point is invalid input
    const badTrait = traits as any;
    await expect(
      t.withIdentity(as(owner)).mutation(api.chat.settings.upsert, {
        workspaceId: ws,
        personalization: badStyle,
      }),
    ).rejects.toThrow();
    await expect(
      t.withIdentity(as(owner)).mutation(api.chat.settings.upsert, {
        workspaceId: ws,
        personalization: badTrait,
      }),
    ).rejects.toThrow();
  });

  test("an unknown TOP-LEVEL field cannot be mass-assigned", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    // biome-ignore lint/suspicious/noExplicitAny: the point is invalid input
    const massAssign = { workspaceId: ws, rateWindowCount: 999_999 } as any;
    await expect(
      t.withIdentity(as(owner)).mutation(api.chat.settings.upsert, massAssign),
    ).rejects.toThrow();
  });

  test("clamping is CODE-POINT safe — never a split surrogate", async () => {
    // `.slice()` cuts UTF-16 units, so slicing mid-emoji stored a lone
    // surrogate that then travelled into the model request.
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    await t.withIdentity(as(owner)).mutation(api.chat.settings.upsert, {
      workspaceId: ws,
      customInstructionsAbout: "🙂".repeat(3000),
    });
    const got = await t
      .withIdentity(as(owner))
      .query(api.chat.settings.get, { workspaceId: ws });
    const stored = got.customInstructionsAbout ?? "";
    expect([...stored].length).toBe(2000);
    // No unpaired surrogate survived the cut.
    expect(/[\uD800-\uDFFF]/.test(stored.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
  });

  test("reset returns defaults and touches NOTHING else", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    await t.withIdentity(as(owner)).mutation(api.chat.settings.upsert, {
      workspaceId: ws,
      personalization: {
        ...PERSONALIZATION_DEFAULTS,
        baseStyle: "playful",
        responseSpeed: "fast",
      },
      customInstructionsAbout: "I work in Rust.",
      memoryEnabled: false,
      sendOnEnter: false,
    });
    await t
      .withIdentity(as(owner))
      .mutation(api.chat.settings.resetPersonalization, { workspaceId: ws });
    const got = await t
      .withIdentity(as(owner))
      .query(api.chat.settings.get, { workspaceId: ws });

    expect(got.personalization).toEqual(PERSONALIZATION_DEFAULTS);
    // Custom instructions are something the user WROTE — reset must not eat it.
    expect(got.customInstructionsAbout).toBe("I work in Rust.");
    // Neither may it touch unrelated preferences.
    expect(got.memoryEnabled).toBe(false);
    expect(got.sendOnEnter).toBe(false);
  });

  test("reset leaves memories and project instructions alone", async () => {
    const t = convexTest(schema, modules);
    const { owner, ws } = await seed(t);
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", {
        workspaceId: ws,
        userId: owner,
        name: "P",
        instructions: "Always cite sources.",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const memoryId = await t.run((ctx) =>
      ctx.db.insert("userMemories", {
        userId: owner,
        workspaceId: ws,
        content: "Ships on Fridays.",
        kind: "fact",
        source: "explicit",
        scope: "user",
        status: "active",
        normalizedKey: "ships on fridays",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await t
      .withIdentity(as(owner))
      .mutation(api.chat.settings.resetPersonalization, { workspaceId: ws });
    await t.run(async (ctx) => {
      const proj = await ctx.db.get(projectId);
      expect(proj && "instructions" in proj ? proj.instructions : null).toBe(
        "Always cite sources.",
      );
      const mem = await ctx.db.get(memoryId);
      expect(mem && "content" in mem ? mem.content : null).toBe(
        "Ships on Fridays.",
      );
    });
  });
});

describe("personalization is per-user, not per-workspace", () => {
  test("one member cannot read or write another member's personalization", async () => {
    const t = convexTest(schema, modules);
    const { owner, other, ws } = await seed(t);
    await t.withIdentity(as(owner)).mutation(api.chat.settings.upsert, {
      workspaceId: ws,
      personalization: { ...PERSONALIZATION_DEFAULTS, baseStyle: "formal" },
    });
    // Same workspace, different member: rows are keyed by_user_workspace, so
    // the other member sees their OWN defaults, never the owner's choice.
    const theirs = await t
      .withIdentity(as(other))
      .query(api.chat.settings.get, { workspaceId: ws });
    expect(theirs.personalization.baseStyle).toBe("default");

    await t.withIdentity(as(other)).mutation(api.chat.settings.upsert, {
      workspaceId: ws,
      personalization: { ...PERSONALIZATION_DEFAULTS, baseStyle: "playful" },
    });
    const ownerAfter = await t
      .withIdentity(as(owner))
      .query(api.chat.settings.get, { workspaceId: ws });
    expect(ownerAfter.personalization.baseStyle).toBe("formal");
  });

  test("an unauthenticated caller cannot read or write", async () => {
    const t = convexTest(schema, modules);
    const { ws } = await seed(t);
    // Read degrades to defaults rather than throwing (no console.error in e2e).
    const got = await t.query(api.chat.settings.get, { workspaceId: ws });
    expect(got.personalization).toEqual(PERSONALIZATION_DEFAULTS);
    await expect(
      t.mutation(api.chat.settings.upsert, {
        workspaceId: ws,
        personalization: PERSONALIZATION_DEFAULTS,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.chat.settings.resetPersonalization, { workspaceId: ws }),
    ).rejects.toThrow();
  });

  test("a non-member cannot write personalization into someone's workspace", async () => {
    const t = convexTest(schema, modules);
    const { ws } = await seed(t);
    const stranger = await t.run((ctx) =>
      ctx.db.insert("users", { email: "stranger@t.test" }),
    );
    await expect(
      t.withIdentity(as(stranger)).mutation(api.chat.settings.upsert, {
        workspaceId: ws,
        personalization: PERSONALIZATION_DEFAULTS,
      }),
    ).rejects.toThrow();
  });
});

describe("the legacy string mirrors the canonical object", () => {
  test("defaults produce no style at all", () => {
    expect(legacyStyleString(PERSONALIZATION_DEFAULTS)).toBeNull();
  });

  test("disabled produces no style even when preferences are set", () => {
    expect(
      legacyStyleString({
        ...PERSONALIZATION_DEFAULTS,
        enabled: false,
        baseStyle: "formal",
      }),
    ).toBeNull();
  });

  test("each axis contributes exactly once", () => {
    const s = legacyStyleString({
      version: 1,
      enabled: true,
      baseStyle: "concise",
      characteristics: ["warm", "emoji"],
      responseSpeed: "fast",
      responseLanguage: "French",
    });
    expect(s).toContain("concise");
    expect(s).toContain("warm");
    expect(s).toContain("emoji");
    expect(s).toContain("fast");
    expect(s).toContain("French");
  });
});
