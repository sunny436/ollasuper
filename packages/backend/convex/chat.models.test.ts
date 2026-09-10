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
  "deepseek-v4-flash",
  "deepseek-v4-pro",
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

  // The pinned id moves whenever the provider's capacity does — it was
  // gpt-5.6-luna (expired upstream credential), then deepseek-v4-pro (account
  // hit its weekly usage limit; 7 of 8 models 429ing on 2026-09-03). What this
  // guards is not the id but the INVARIANT: the default must be a real curated
  // entry and must lead the picker, because a default that is not in the list
  // is what broke chat both times.
  test("the default is Qwen 3.5 and it leads the list", async () => {
    // Was deepseek-v4-flash, which had been chosen for AVAILABILITY during a
    // weekly-quota outage when it was the only model answering. Once that
    // cleared it was the wrong default on the axis users actually feel: it is
    // the SLOWEST catalogue model to start answering a real question (4.88s to
    // first token, ~80% of its output being hidden reasoning) despite being the
    // fastest raw generator. qwen3.5 measured 0.72s on the same prompt.
    //
    // This matters more now than it did: with the model picker removed, this
    // constant is what every new thread gets whenever the Master Model Router
    // is off, including on rollback.
    const t = convexTest(schema, modules);
    expect(DEFAULT_MODEL).toBe("qwen3.5");
    serve(ALL_CURATED);
    await t.action(internal.chat.models.refresh, {});
    const listed = await t.query(api.chat.models.list, {});
    // The invariant that actually broke chat twice: the default must be IN the
    // catalogue, and it leads the list.
    expect(listed[0].modelId).toBe(DEFAULT_MODEL);
    expect(listed[0].name).toBe("Qwen 3.5");
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

  test("the app keeps NO copy of the model default to drift from", async () => {
    // This used to assert that two constants for one value still agreed,
    // because they had already drifted once: the backend moved to
    // deepseek-v4-pro when the gpt-5* family stopped serving, the app's mirror
    // stayed on gpt-5.6-luna, and the picker seeded every session with a model
    // that had left the catalogue — a new thread sent an id that no longer
    // matched thread.model and threw "Unsupported model".
    //
    // The Master Model Router removed the client's side of that pair outright:
    // the browser no longer names a model, so there is nothing left to drift.
    // Asserting the ABSENCE is strictly stronger than asserting agreement —
    // agreement can break, absence cannot — so the test guards that instead of
    // being deleted along with the file it used to read.
    const { existsSync, readdirSync, readFileSync } = await import("node:fs");
    const chatDir = new URL(
      "../../../apps/app/src/app/[locale]/(workspace)/chat/_lib/",
      import.meta.url,
    );
    expect(existsSync(new URL("models.ts", chatDir))).toBe(false);
    // And no sibling has quietly reintroduced one.
    for (const f of readdirSync(chatDir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(new URL(f, chatDir), "utf8");
      expect(src).not.toMatch(/export const DEFAULT_MODEL/);
    }
  });

  test("the default model is one the picker actually offers", async () => {
    // A default outside the catalogue is the same failure by another route.
    expect(ALL_CURATED).toContain(DEFAULT_MODEL);
  });

  // --- Master Model Router candidate set ------------------------------
  //
  // The router is a PURE function in the Python plane, so it cannot read this
  // table itself; Convex ships the candidates inside the dispatch payload.
  test("routableCandidates returns every catalogue model with its window", async () => {
    const t = convexTest(schema, modules);
    serve(ALL_CURATED);
    await t.action(internal.chat.models.refresh, {});
    const cands = await t.run(async (ctx) =>
      (await import("./chat/models")).routableCandidates(ctx),
    );
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.map((c) => c.id)).toContain(DEFAULT_MODEL);
    // Every candidate carries a window, even when it is 0 = NOT MEASURED.
    // 0 and a real number are different facts and routing.py must be able to
    // tell them apart, so the field is always present.
    expect(cands.every((c) => typeof c.contextWindow === "number")).toBe(true);
  });

  test("routableCandidates never offers a denylisted model", async () => {
    // Offering a model that cannot serve is the failure that took chat down
    // twice; the router must not be handed one as a candidate either.
    const t = convexTest(schema, modules);
    process.env.MODEL_DENY_PREFIXES = "glm";
    serve(ALL_CURATED);
    await t.action(internal.chat.models.refresh, {});
    const cands = await t.run(async (ctx) =>
      (await import("./chat/models")).routableCandidates(ctx),
    );
    expect(cands.some((c) => c.id.startsWith("glm"))).toBe(false);
  });

  // REGRESSION. The candidate set was first added to chat/stream.ts:active by
  // mistake — the browser's hot subscription, and the ONLY query that re-fires
  // during a generation. That shipped the whole catalogue to the client on
  // every token batch AND put model identity back into client state, which is
  // exactly what removing the picker was meant to end. It belongs on the
  // internal dispatch payload and nowhere else.
  test("the client stream query leaks neither model nor candidates", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./chat/stream.ts", import.meta.url), "utf8");
    const active = src.slice(
      src.indexOf("export const active"),
      src.indexOf("export const stop"),
    );
    expect(active).not.toMatch(/modelCandidates/);
    expect(active).not.toMatch(/^s+model: message.model/m);
    // ...and the dispatch payload DOES carry them.
    const dispatch = src.slice(src.indexOf("export const dispatchPayload"));
    expect(dispatch).toContain("modelCandidates: await routableCandidates(ctx)");
  });

  test("the list query exposes the description the picker renders", async () => {
    const t = convexTest(schema, modules);
    serve(ALL_CURATED);
    await t.action(internal.chat.models.refresh, {});
    const listed = await t.query(api.chat.models.list, {});
    expect(listed.every((m) => typeof m.description === "string")).toBe(true);
  });
});
