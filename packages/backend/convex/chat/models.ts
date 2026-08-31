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

const OLLIMA_MODELS_URL = "https://api.ollima.com/v1/models";

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
}[] = [
  {
    modelId: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    description: "Fastest to answer. The default for everyday work.",
  },
  {
    modelId: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    description: "Lighter and quicker, for short back-and-forth.",
  },
  {
    modelId: "glm-5.2",
    name: "GLM 5.2",
    description: "Strong all-rounder for coding and agentic work.",
  },
  {
    modelId: "glm-5.1",
    name: "GLM 5.1",
    description: "The previous GLM generation.",
  },
  {
    modelId: "qwen3.5",
    name: "Qwen 3.5",
    description: "Multilingual generalist.",
  },
  {
    modelId: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    description: "Open-weight, 120B parameters.",
  },
  {
    modelId: "tensorzero::model_name::grok-4.5",
    name: "Grok 4.5",
    description: "Conversational reasoning.",
  },
  {
    modelId: "tensorzero::model_name::gemini-3.7-flash-high",
    name: "Gemini 3.7 Flash",
    description: "Fast, with a long context window.",
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
  contextLength: 0,
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
  handler: async (ctx): Promise<{ fetched: number; kept: number; applied: boolean }> => {
    // No credentials: this endpoint is public, and keeping it that way is what
    // lets the key stay on the inference plane only.
    const res = await fetch(OLLIMA_MODELS_URL);
    if (!res.ok) {
      throw new Error(`Ollima /v1/models responded ${res.status}`);
    }
    const body = (await res.json()) as { data?: OllimaModel[] };
    const raw = Array.isArray(body.data) ? body.data : [];
    // Intersect the curated list with what the provider currently advertises,
    // so a model they retire disappears on its own. If the fetch came back
    // empty or unrecognisable, keep the curated list rather than emptying the
    // picker over a bad response.
    const advertised = new Set(
      raw.map((m) => (typeof m.id === "string" ? m.id : "")).filter(Boolean),
    );
    const denied = deniedPrefixes();
    const entries = CURATED.filter(
      (e) =>
        isServable(e.modelId, denied) &&
        (advertised.size === 0 || advertised.has(e.modelId)),
    );

    const applied: boolean = await ctx.runMutation(
      internal.chat.models.apply,
      { entries },
    );
    return { fetched: raw.length, kept: entries.length, applied };
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
