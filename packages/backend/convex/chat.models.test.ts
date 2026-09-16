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
  unsetEnv("OLLIMA_MODELS_URL");
});

type T = ReturnType<typeof convexTest>;
const rowsIn = (t: T) =>
  t.run(async (ctx) => ctx.db.query("chatModels").collect());

// Three ROUTABLE models (one per reasoning tier, profiled in
// services/ai/app/config.py) plus two EMERGENCY entries that carry no profile
// and are therefore only reachable when all three primaries are unhealthy.
const ROUTABLE = [
  "deepseek-v4-flash",
  "gemini-3.7-flash-high",
  "gemini-3.8-flash-high",
];
const EMERGENCY = ["gpt-oss-120b", "grok-4.3"];
const ALL_CURATED = [...ROUTABLE, ...EMERGENCY];

describe("the model catalogue is a curated shortlist", () => {
  test("exactly the five curated models are offered", async () => {
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
  test("the default is the BALANCED model and it leads the list", async () => {
    // The default is what runs when the Master Model Router is off, when it
    // errors, and on rollback — and with no model picker in the UI, it is what
    // every new thread gets. So it is deliberately the MIDDLE tier rather than
    // the fastest (gemini-3.7, 2.97s) or the deepest (gemini-3.8, 5.23s): a
    // competent answer is the better failure mode in both directions.
    //
    // It is also where retired ids land. assertAllowedModel(explicit:false)
    // re-homes a thread carrying an id no longer in the catalogue, so every
    // conversation still on qwen3.5 or glm-5.2 heals itself onto this one.
    const t = convexTest(schema, modules);
    expect(DEFAULT_MODEL).toBe("deepseek-v4-flash");
    serve(ALL_CURATED);
    await t.action(internal.chat.models.refresh, {});
    const listed = await t.query(api.chat.models.list, {});
    // The invariant that actually broke chat twice: the default must be IN the
    // catalogue, and it leads the list.
    expect(listed[0].modelId).toBe(DEFAULT_MODEL);
    expect(listed[0].name).toBe("DeepSeek V4 Flash");
  });

  test("the routable three are all present and carry plain ids", async () => {
    // The endpoint this deployment moved to serves PLAIN ids; the old
    // `tensorzero::model_name::` forms belong to the endpoint that is gone.
    // Probed 2026-09-16: all three answer 200 at /v1/chat/completions.
    const t = convexTest(schema, modules);
    serve(ALL_CURATED);
    await t.action(internal.chat.models.refresh, {});
    const ids = (await rowsIn(t)).map((m) => m.modelId);
    for (const id of ROUTABLE) expect(ids).toContain(id);
    expect(ids.some((id) => id.startsWith("tensorzero::"))).toBe(false);
  });

  test("no probe host configured means no probe, and the catalogue still ships", async () => {
    // The URL is env-driven and unset by default: the previous hardcoded host
    // outlived the endpoint it named, and nothing noticed because the failure
    // looked like a cron error rather than a stale catalogue.
    const t = convexTest(schema, modules);
    const res = await t.action(internal.chat.models.refresh, {});
    expect(res.probe).toBe("skipped");
    expect(res.applied).toBe(true);
  });

  test("a failed /v1/models probe still publishes the catalogue", async () => {
    process.env.OLLIMA_MODELS_URL = "http://probe.invalid/v1/models";
    // It used to throw, which let a probe that contributes NOTHING block a
    // write that does not depend on it. Measured 2026-09-16: the old host
    // stopped accepting TCP and the new one answers 401 on /v1/models, so every
    // 6-hourly run failed and the table could never pick up a new roster.
    const t = convexTest(schema, modules);
    globalThis.fetch = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    const res = await t.action(internal.chat.models.refresh, {});
    expect(res.applied).toBe(true);
    expect(res.probe).not.toBe("ok");
    const ids = (await rowsIn(t)).map((m) => m.modelId).sort();
    expect(ids).toEqual([...ALL_CURATED].sort());
  });

  test("an unreachable probe host does not break the refresh either", async () => {
    process.env.OLLIMA_MODELS_URL = "http://probe.invalid/v1/models";
    const t = convexTest(schema, modules);
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const res = await t.action(internal.chat.models.refresh, {});
    expect(res.applied).toBe(true);
    expect(res.probe).toContain("unreachable");
  });

  test("the curated list does not depend on what /v1/models advertises", async () => {
    // The endpoint is not a reliable inventory: it advertises the whole gpt-5*
    // family, none of which can serve a request, and omits models that answer
    // 200 at /chat/completions. Intersecting with it dropped working models and
    // kept dead ones, so the hand-probed CURATED list wins outright.
    const t = convexTest(schema, modules);
    serve([]);
    const res = await t.action(internal.chat.models.refresh, {});
    expect(res.applied).toBe(true);
    const ids = (await rowsIn(t)).map((m) => m.modelId).sort();
    expect(ids).toEqual([...ALL_CURATED].sort());
  });

  test("a namespaced id round-trips through apply without being mangled", async () => {
    // The catalogue no longer carries any `tensorzero::model_name::` id — the
    // endpoint that served those is gone, and the current one uses plain ids.
    // The PROPERTY those models were guarding is still worth keeping: an id
    // with separators in it must survive the write verbatim, or a future
    // namespaced model would be silently unroutable. Asserted on the write path
    // directly rather than by keeping two dead models in the shortlist.
    const t = convexTest(schema, modules);
    const weird = "tensorzero::model_name::some-future-model";
    await t.mutation(internal.chat.models.apply, {
      entries: [
        {
          modelId: weird,
          name: "Future",
          description: "A namespaced id.",
          contextLength: 0,
          promptPrice: "",
          completionPrice: "",
          vision: true,
        },
      ],
    });
    expect((await rowsIn(t)).map((m) => m.modelId)).toContain(weird);
  });

  test("the denylist still applies on top", async () => {
    const t = convexTest(schema, modules);
    process.env.MODEL_DENY_PREFIXES = "gemini";
    serve(ALL_CURATED);
    await t.action(internal.chat.models.refresh, {});
    const ids = (await rowsIn(t)).map((m) => m.modelId);
    expect(ids).not.toContain("gemini-3.7-flash-high");
    expect(ids).not.toContain("gemini-3.8-flash-high");
    expect(ids).toContain("deepseek-v4-flash");
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
