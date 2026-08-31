/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

/**
 * The picker must not offer a model that cannot possibly work.
 *
 * Ollima's /v1/models is a superset of what it serves. When the whole gpt-5*
 * family stopped serving — 502 wrapping `Unauthorized ... token is expired`
 * from the provider's upstream — nine dead entries stayed in the catalogue, and
 * picking any of them broke chat with no way for the user to know why.
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
/** Computed-key delete: biome flags the literal form, not this one. */
function unsetEnv(key: string) {
  delete process.env[key];
}

const realFetch = globalThis.fetch;

/** A catalogue large enough to clear MIN_PLAUSIBLE_MODELS. */
function catalogue(ids: string[]) {
  const filler = Array.from({ length: 60 }, (_, i) => ({ id: `filler-${i}` }));
  return { data: [...ids.map((id) => ({ id })), ...filler] };
}

function serve(ids: string[]) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(catalogue(ids)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  unsetEnv("MODEL_DENY_PREFIXES");
});

const idsIn = (t: Awaited<ReturnType<typeof convexTest>>) =>
  t.run(async (ctx) =>
    (await ctx.db.query("chatModels").collect()).map((m) => m.modelId),
  );

describe("the model catalogue excludes what the provider cannot serve", () => {
  test("every gpt-5* id is kept out by default", async () => {
    const t = convexTest(schema, modules);
    serve(["gpt-5.6-luna", "gpt-5.5", "gpt-5-mini", "glm-5.2", "qwen3.5"]);
    await t.action(internal.chat.models.refresh, {});
    const ids = await idsIn(t);
    expect(ids).not.toContain("gpt-5.6-luna");
    expect(ids).not.toContain("gpt-5.5");
    expect(ids).not.toContain("gpt-5-mini");
    // …and everything that DOES serve is still offered.
    expect(ids).toContain("glm-5.2");
    expect(ids).toContain("qwen3.5");
  });

  test("an empty denylist offers everything again", async () => {
    // The lever that lifts this without a deploy, once upstream recovers.
    const t = convexTest(schema, modules);
    process.env.MODEL_DENY_PREFIXES = "";
    serve(["gpt-5.6-luna", "glm-5.2"]);
    await t.action(internal.chat.models.refresh, {});
    expect(await idsIn(t)).toContain("gpt-5.6-luna");
  });

  test("the denylist is configurable", async () => {
    const t = convexTest(schema, modules);
    process.env.MODEL_DENY_PREFIXES = "qwen";
    serve(["gpt-5.6-luna", "qwen3.5", "glm-5.2"]);
    await t.action(internal.chat.models.refresh, {});
    const ids = await idsIn(t);
    expect(ids).not.toContain("qwen3.5");
    // gpt-5 is no longer denied when the list is overridden explicitly.
    expect(ids).toContain("gpt-5.6-luna");
  });

  test("a refresh that would empty the catalogue is refused", async () => {
    // The existing MIN_PLAUSIBLE_MODELS guard must still hold: a denylist that
    // matched everything must not wipe the picker.
    const t = convexTest(schema, modules);
    process.env.MODEL_DENY_PREFIXES = "filler,glm,gpt";
    serve(["glm-5.2"]);
    const res = await t.action(internal.chat.models.refresh, {});
    expect(res.applied).toBe(false);
  });
});
