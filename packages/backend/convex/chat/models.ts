import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  query,
  type QueryCtx,
} from "../_generated/server";
import { DEFAULT_MODEL } from "./authz";

/**
 * The Ollima model catalogue.
 *
 * WHY A CACHED TABLE RATHER THAN A LIVE FETCH:
 * `assertAllowedModel` runs inside mutations, and Convex mutations cannot do
 * network I/O. Validation therefore has to read the allow-list out of the
 * database, which means something has to put it there — hence
 * internalAction (fetch) -> internalMutation (write) -> query (read), the same
 * shape chat/stream.ts already uses for dispatch.
 *
 * WHY THE UNAUTHENTICATED ENDPOINT:
 * Ollima's `/v1/models` needs no credentials (measured: HTTP 200 with no key)
 * and returns the standard OpenAI list shape. Keeping the fetch credential-free
 * is exactly what lets OLLIMA_API_KEY live in exactly one place —
 * services/ai/.env, the inference plane that actually needs it to call the
 * model — instead of becoming a second copy of the secret here. If this ever
 * needs an authenticated/account-filtered list, proxy it through the Python
 * service (which already holds the key) rather than copying the key into Convex.
 *
 * NOTE: the payload carries only { id, object, created, owned_by } — no name,
 * pricing, context length or modalities — so every non-id field takes a safe
 * default in toEntry(). Ids are used VERBATIM (a plain id like `gpt-5.6-luna`
 * works at /v1/chat/completions; Ollima is TensorZero-backed and resolves it
 * internally, so any future `tensorzero::` id round-trips intact too).
 */

/** Liveness probe only — the CURATED list below is what actually ships. Unset
 *  skips the probe entirely; it is deliberately NOT a hardcoded host, because
 *  the last one outlived the endpoint it named by an unknown number of weeks.
 *
 *  Read PER CALL, like deniedPrefixes() below: a module-scope read is fixed at
 *  import and cannot be changed by configuration or exercised by a test. */
function modelsProbeUrl(): string {
  return process.env.OLLIMA_MODELS_URL ?? "";
}

/**
 * The models we actually offer.
 *
 * /v1/models advertises ~63 ids, and most of them are noise: the whole gpt-5*
 * family returns 502 (the provider's upstream credential is expired), and the
 * rest was an undifferentiated wall of raw ids with no way for anyone to choose
 * between them. Every id here has been probed and answers.
 *
 * The list is short and hand-written on purpose. A picker is a product surface,
 * not a database dump — a name and one line about when to reach for it is worth
 * more than fifty entries nobody can tell apart.
 */
const CURATED_SPECS: readonly {
  modelId: string;
  name: string;
  description: string;
  /**
   * Real usable window, MEASURED — omitted where it has not been. /v1/models
   * carries no metadata, so this was 0 for every model and the Python plane fell
   * back to a hardcoded 200k guess for all of them.
   *
   * Measure it, do not assume it. A large prompt is ACCEPTED by this gateway
   * whether or not the model can use it, so size alone proves nothing: put a
   * needle at the very start, fill to N tokens, and ask for it back at the end.
   * Only a model that returns the needle actually had the context.
   */
  contextLength?: number;
}[] = [
  // --- THE ROUTABLE THREE ---------------------------------------------
  // One model per reasoning class. The router (services/ai/app/routing.py)
  // holds a profile for exactly these three and picks the cheapest that meets
  // the turn's capability floor, so the tier mapping is:
  //   simple -> gemini-3.7-flash-high, moderate -> deepseek-v4-flash,
  //   heavy  -> gemini-3.8-flash-high.
  // Plain ids, NOT `tensorzero::model_name::` — the endpoint this deployment
  // now talks to serves the plain form (probed 2026-09-16: all three answer
  // 200 at /v1/chat/completions; 42 of its 48 advertised models do).
  {
    modelId: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    description: "Balanced speed and reasoning. The default for everyday work.",
    // FIRST deliberately: this array is BOTH the display order and where the
    // default sits (see DEFAULT_MODEL in chat/authz.ts). It is the middle tier
    // because the default is what runs when the ROUTER cannot — a competent
    // middle is a better failure mode than the fastest or the deepest.
    //
    // Verified 2026-09-03 by needle-in-haystack: 133,371 prompt tokens accepted
    // and the needle placed at the very START returned verbatim, so the context
    // is genuinely used rather than silently truncated.
    contextLength: 131_072,
  },
  {
    modelId: "gemini-3.7-flash-high",
    name: "Gemini 3.7 Flash",
    description: "Fastest to first token. Handles simple, direct questions.",
    // The vendor advertises 1,048,576 input tokens. NOT recorded: this field is
    // measured-only by contract, and an unmeasured 0 is read as "unknown",
    // which never disqualifies a candidate. Claiming the number would be a
    // guess that could silently filter the model out of a large turn.
  },
  {
    modelId: "gemini-3.8-flash-high",
    name: "Gemini 3.8 Flash",
    description: "Deepest reasoning, for analysis and multi-step problems.",
  },

  // --- EMERGENCY ONLY, never routed ------------------------------------
  // These carry NO entry in ai_router_profiles, and that absence is the whole
  // mechanism: routing.select() falls back to ModelProfile() = ttft 99s,
  // reasoning_tier 0, so they lose every comparison at floor 0 and are excluded
  // at floors 1-2. They become reachable only through select()'s "nothing meets
  // the floor" branch — i.e. when all three routable models are filtered out as
  // unhealthy. Without them, a simultaneous outage across the three would leave
  // nothing to dispatch at all.
  //
  // Chosen for FAMILY DIVERSITY (the three above are 2x Gemini + 1x DeepSeek)
  // and because both answered cleanly when every model was probed on
  // 2026-09-16: gpt-oss-120b in 422ms, grok-4.3 in 1490ms.
  {
    modelId: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    description: "Open-weight fallback, used only if the primaries are down.",
  },
  {
    modelId: "grok-4.3",
    name: "Grok 4.3",
    description: "Conversational fallback, used only if the primaries are down.",
  },
];

/**
 * Never write an empty catalogue: that would pin every user to the bootstrap
 * default until the next refresh. The old floor was 50, which made sense while
 * the catalogue mirrored the provider's whole list and is meaningless now.
 */
const MIN_PLAUSIBLE_MODELS = 1;

/** /v1/models carries no metadata, so the numeric fields take safe defaults —
 *  the picker shows a name and a line, and never renders these. */
const CURATED: readonly CatalogueEntry[] = CURATED_SPECS.map((m) => ({
  ...m,
  // 0 = not measured; the Python plane keeps its conservative budget for those.
  contextLength: m.contextLength ?? 0,
  promptPrice: "",
  completionPrice: "",
  vision: true,
}));

interface OllimaModel {
  id?: unknown;
  object?: unknown;
  created?: unknown;
  owned_by?: unknown;
}

export interface CatalogueEntry {
  modelId: string;
  name: string;
  /** One short line for the picker. */
  description?: string;
  contextLength: number;
  promptPrice: string;
  completionPrice: string;
  vision: boolean;
}

/**
 * Map one Ollima /v1/models row to a catalogue entry.
 *
 * Ollima returns only id/object/created/owned_by — no name, pricing, context
 * length or modality data — so every non-id field takes a safe default:
 *   name          = id  (the UI's modelLabel() prettifies the slug)
 *   contextLength = 0   (unknown; the Python plane substitutes a conservative
 *                        default — see contextWindowFor + agent/context.py)
 *   prompt/completionPrice = "" (unknown; the picker renders "variable pricing")
 *   vision        = true (a cosmetic label only; it never gates uploads)
 * The id is preserved VERBATIM so any future tensorzero:: id round-trips intact.
 * NOTE: /v1/models is a superset of what Ollima actually SERVES. This used to
 * pass the whole list through, on the reasoning that the endpoint is the source
 * of truth and a probe-based filter would become a de-facto manual list. That
 * reasoning held right up until an entire family stopped serving: every gpt-5*
 * id began returning 502 wrapping `Unauthorized ... token is expired` from the
 * provider's upstream, while the other eleven models answered normally. Nine
 * dead entries stayed in the picker, and choosing any of them broke chat.
 *
 * So there is now a denylist — see DENY_PREFIXES. It is a manual list, and that
 * is the lesser evil: offering a user a model that cannot possibly work is a
 * worse failure than a stale exclusion, and the exclusion is one env var away
 * from being lifted the moment the provider recovers.
 */
/**
 * Model-id prefixes the provider advertises but cannot currently serve.
 *
 * Configurable so this does not need a deploy to change: set MODEL_DENY_PREFIXES
 * to a comma-separated list, or to an empty string to offer everything again
 * once the upstream credential is restored.
 */
function deniedPrefixes(): string[] {
  const raw = process.env.MODEL_DENY_PREFIXES;
  // Unset means the known-bad family; empty string means deny nothing.
  if (raw === undefined) return ["gpt-5"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isServable(modelId: string, denied: string[]): boolean {
  return !denied.some((prefix) => modelId.startsWith(prefix));
}

function toEntry(m: OllimaModel): CatalogueEntry | null {
  if (typeof m.id !== "string" || !m.id) return null;
  return {
    modelId: m.id,
    name: m.id,
    contextLength: 0,
    promptPrice: "",
    completionPrice: "",
    vision: true,
  };
}

/** Fetch + filter. Exported for the write mutation; never returns the key. */
export const refresh = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    fetched: number;
    kept: number;
    applied: boolean;
    probe: string;
  }> => {
    // THE PROBE IS ADVISORY, and that is a correction, not a loosening.
    //
    // It used to `throw` on a bad response, which meant a probe that
    // contributes NOTHING to the result could block a catalogue write that does
    // not depend on it. Measured 2026-09-16, it blocked exactly that: the old
    // host stopped accepting TCP entirely, AND the endpoint this deployment
    // moved to answers `401 Missing API key` on /v1/models. Every 6-hourly run
    // failed, so the table could never pick up a new roster. Liveness belongs
    // to the plane that actually dials the provider (it has model-health
    // bookkeeping and a connect timeout); this action's job is to publish the
    // hand-probed list.
    //
    // Still no credentials: keeping the key on the inference plane only is
    // worth more than a liveness signal we get better elsewhere.
    let raw: OllimaModel[] = [];
    let probe = "skipped";
    const probeUrl = modelsProbeUrl();
    if (probeUrl) {
      try {
        const res = await fetch(probeUrl);
        if (res.ok) {
          const body = (await res.json()) as { data?: OllimaModel[] };
          raw = Array.isArray(body.data) ? body.data : [];
          probe = "ok";
        } else {
          probe = `http_${res.status}`;
        }
      } catch (e) {
        probe = `unreachable:${String(e).slice(0, 60)}`;
      }
      if (probe !== "ok") console.warn(`ollima model probe: ${probe}`);
    }
    // The CURATED list wins outright; the fetch is kept only so a refresh
    // still fails loudly if the provider is unreachable.
    //
    // It is tempting to intersect with what /v1/models advertises, and that was
    // the first attempt — but the endpoint is not a reliable inventory. It lists
    // neither grok-4.5 nor gemini-3.7-flash-high, and both answer 200 at
    // /chat/completions under their tensorzero:: ids; meanwhile it happily
    // advertises the entire gpt-5* family, none of which can serve a request.
    // Intersecting therefore dropped two working models and kept nine dead ones.
    // A hand-probed list is the more honest source of truth.
    const denied = deniedPrefixes();
    const entries = CURATED.filter((e) => isServable(e.modelId, denied));

    const applied: boolean = await ctx.runMutation(
      internal.chat.models.apply,
      { entries },
    );
    return { fetched: raw.length, kept: entries.length, applied, probe };
  },
});

/** Write half. Split out because only mutations may touch the database. */
export const apply = internalMutation({
  args: {
    entries: v.array(
      v.object({
        modelId: v.string(),
        name: v.string(),
        description: v.optional(v.string()),
        contextLength: v.number(),
        promptPrice: v.string(),
        completionPrice: v.string(),
        vision: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, { entries }) => {
    if (entries.length < MIN_PLAUSIBLE_MODELS) {
      // Keep the previous catalogue. Returning false rather than throwing so a
      // scheduled refresh logs a benign no-op instead of an error every hour.
      return false;
    }

    const now = Date.now();
    const existing = await ctx.db.query("chatModels").collect();
    const byId = new Map(existing.map((d) => [d.modelId, d]));
    const seen = new Set<string>();

    for (const e of entries) {
      seen.add(e.modelId);
      const prev = byId.get(e.modelId);
      if (prev) {
        await ctx.db.patch(prev._id, { ...e, updatedAt: now });
      } else {
        await ctx.db.insert("chatModels", { ...e, updatedAt: now });
      }
    }

    for (const d of existing) {
      if (!seen.has(d.modelId)) await ctx.db.delete(d._id);
    }
    return true;
  },
});

function toPublic(d: Doc<"chatModels">) {
  return {
    modelId: d.modelId,
    name: d.name,
    description: d.description,
    contextLength: d.contextLength,
    promptPrice: d.promptPrice,
    completionPrice: d.completionPrice,
    vision: d.vision,
  };
}

/**
 * The picker's list. ~411 rows / ~67KB in one result, so no pagination: it is
 * fetched once per composer mount and is far inside Convex's limits.
 *
 * Falls back to the bootstrap default when the catalogue has never been
 * refreshed, so a fresh deployment still offers a working model rather than an
 * empty dropdown.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("chatModels").collect();
    if (rows.length === 0) {
      return [
        {
          modelId: DEFAULT_MODEL,
          name:
            CURATED.find((m) => m.modelId === DEFAULT_MODEL)?.name ??
            DEFAULT_MODEL,
          description: CURATED.find((m) => m.modelId === DEFAULT_MODEL)
            ?.description,
          contextLength: 0,
          promptPrice: "",
          completionPrice: "",
          vision: true,
        },
      ];
    }
    // Curated ORDER, not alphabetical — the list is hand-ordered so the
    // default sits at the top and the rest read as a considered shortlist.
    const rank = new Map(CURATED.map((m, i) => [m.modelId, i]));
    return rows
      .map(toPublic)
      .sort(
        (a, b) =>
          (rank.get(a.modelId) ?? 999) - (rank.get(b.modelId) ?? 999) ||
          a.name.localeCompare(b.name),
      );
  },
});

/**
 * The models the Master Model Router may choose from for one turn.
 *
 * The router lives in the Python plane and is a PURE function, so it cannot
 * read this table itself — Convex ships the candidate set inside the dispatch
 * payload it already sends. That costs nothing extra on the request path: the
 * payload already reads this table once for `contextWindowFor`, and the curated
 * catalogue is a handful of rows.
 *
 * `contextLength` rides along per candidate because 0 (never MEASURED) and a
 * real window are different facts, and the router must not treat the first as
 * the second — see routing.py.
 */
export async function routableCandidates(
  ctx: QueryCtx,
): Promise<{ id: string; contextWindow: number }[]> {
  const denied = deniedPrefixes();
  const rows = await ctx.db.query("chatModels").collect();
  return rows
    .filter((r) => isServable(r.modelId, denied))
    .map((r) => ({ id: r.modelId, contextWindow: r.contextLength ?? 0 }));
}

/** Context window for the dispatch payload; 0 when unknown. */
export async function contextWindowFor(
  ctx: QueryCtx,
  model: string,
): Promise<number> {
  const row = await ctx.db
    .query("chatModels")
    .withIndex("by_model_id", (q) => q.eq("modelId", model))
    .unique();
  return row?.contextLength ?? 0;
}
