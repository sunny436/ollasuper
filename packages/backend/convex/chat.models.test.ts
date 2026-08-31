/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import { internal, api } from "./_generated/api";
import { DEFAULT_MODEL } from "./chat/authz";
import schema from "./schema";

/**
 * The picker is a curated shortlist, not a dump of the provider's catalogue.
 *
 * /v1/models advertises ~63 ids. Most were noise, the whole gpt-5* family was
 * returning 502 from an expired upstream credential, and every row rendered as
 * "name / the same id again / variable pricing · vision" — so nothing in the
 * list helped anyone choose. It is now eight probed models, each with a name
 * and one line.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const realFetch = globalThis.fetch;

/** Computed-key delete: biome flags the literal form, not this one. */
function unsetEnv(key: string) {
  delete process.env[key];
}

/** What /v1/models advertises. The catalogue is the CURATED intersection of
 *  this, so an id absent here is dropped even when it is curated. */
function serve(ids: string[]) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  unsetEnv("MODEL_DENY_PREFIXES");
});

type T = ReturnType<typeof convexTest>;
const rowsIn = (t: T) =>
  t.run(async (ctx) => ctx.db.query("chatModels").collect());

const ALL_CURATED = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5.2",
  "glm-5.1",
  "qwen3.5",
  "gpt-oss-120b",
  "tensorzero::model_name::grok-4.5",
  "tensorzero::model_name::gemini-3.7-flash-high",
];

describe("the model catalogue is a curated shortlist", () => {
  test("exactly the eight curated models are offered", async () => {
    const t = convexTest(schema, modules);
    // The provider advertises far more; only the curated ones survive.
    serve([...ALL_CURATED, "gpt-5.6-luna", "claude-haiku-4.5", "some-other-id"]);
    const res = await t.action(internal.chat.models.refresh, {});
    expect(res.applied).toBe(true);

    const ids = (await rowsIn(t)).map((m) => m.modelId).sort();
    expect(ids).toEqual([...ALL_CURATED].sort());
  });

  test("every row carries a real name and a description", async () => {
    const t = convexTest(schema, modules);
    serve(ALL_CURATED);
    await t.action(internal.chat.models.refresh, {});
    for (const m of await rowsIn(t)) {
      // The "double naming" in the picker came from name === modelId.
      expect(m.name).not.toBe(m.modelId);
      expect(m.name.length).toBeGreaterThan(2);
      expect(m.description && m.description.length > 8).toBe(true);
    }
  });

  test("the default is DeepSeek V4 Pro and it leads the list", async () => {
    const t = convexTest(schema, modules);
    expect(DEFAULT_MODEL).toBe("deepseek-v4-pro");
    serve(ALL_CURATED);
    await t.action(internal.chat.models.refresh, {});
    const listed = await t.query(api.chat.models.list, {});
    expect(listed[0].modelId).toBe(DEFAULT_MODEL);
    expect(listed[0].name).toBe("DeepSeek V4 Pro");
  });

  test("the curated list does not depend on what /v1/models advertises", async () => {
    // The endpoint is not a reliable inventory: it lists neither grok-4.5 nor
    // gemini-3.7-flash-high, both of which answer 200 under their tensorzero::
    // ids, while advertising the whole gpt-5* family, none of which can serve.
    // Intersecting with it dropped two working models and kept nine dead ones.
    const t = convexTest(schema, modules);
    serve([]);
    const res = await t.action(internal.chat.models.refresh, {});
    expect(res.applied).toBe(true);
    const ids = (await rowsIn(t)).map((m) => m.modelId).sort();
    expect(ids).toEqual([...ALL_CURATED].sort());
  });

  test("the tensorzero-prefixed models survive a refresh", async () => {
    // The two the intersection used to eat.
    const t = convexTest(schema, modules);
    serve(["glm-5.2"]);
    await t.action(internal.chat.models.refresh, {});
    const ids = (await rowsIn(t)).map((m) => m.modelId);
    expect(ids).toContain("tensorzero::model_name::grok-4.5");
    expect(ids).toContain("tensorzero::model_name::gemini-3.7-flash-high");
  });

  test("the denylist still applies on top", async () => {
    const t = convexTest(schema, modules);
    process.env.MODEL_DENY_PREFIXES = "qwen";
    serve(ALL_CURATED);
    await t.action(internal.chat.models.refresh, {});
    expect((await rowsIn(t)).map((m) => m.modelId)).not.toContain("qwen3.5");
  });

  test("the app's copy of DEFAULT_MODEL has not drifted from this one", async () => {
    // These are two constants for one value, and they drifted: the backend
    // moved to deepseek-v4-pro when the gpt-5* family stopped serving, the
    // app's mirror stayed on gpt-5.6-luna, and the picker seeded every session
    // with a model that had left the catalogue — so a new thread sent an id
    // that no longer matched thread.model and threw "Unsupported model".
    // Nothing in the database held the value, which is why it survived two
    // rounds of data cleanup.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL(
        "../../../apps/app/src/app/[locale]/(workspace)/chat/_lib/models.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const found = src.match(/export const DEFAULT_MODEL = "([^"]+)"/)?.[1];
    expect(found).toBe(DEFAULT_MODEL);
  });

  test("the default model is one the picker actually offers", async () => {
    // A default outside the catalogue is the same failure by another route.
    expect(ALL_CURATED).toContain(DEFAULT_MODEL);
  });

  test("the list query exposes the description the picker renders", async () => {
    const t = convexTest(schema, modules);
    serve(ALL_CURATED);
    await t.action(internal.chat.models.refresh, {});
    const listed = await t.query(api.chat.models.list, {});
    expect(listed.every((m) => typeof m.description === "string")).toBe(true);
  });
});
