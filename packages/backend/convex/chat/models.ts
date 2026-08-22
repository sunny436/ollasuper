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
 * Refuse to apply deletions below this many models.
 *
 * Without a floor, one truncated or partially-failed response empties the
 * catalogue, `assertAllowedModel` falls back to the bootstrap default, and
 * every user is silently pinned to one model until the next refresh. Rejecting
 * an implausible response and keeping yesterday's catalogue is always the
 * better failure.
 */
const MIN_PLAUSIBLE_MODELS = 50;

interface OllimaModel {
  id?: unknown;
  object?: unknown;
  created?: unknown;
  owned_by?: unknown;
}

export interface CatalogueEntry {
  modelId: string;
  name: string;
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
 * NOTE: /v1/models is a superset of what Ollima actually serves — a few ids are
 * advertised but unserved; picking one fails at generation (surfaced by the
 * normal error UI). We do NOT filter here — the endpoint is the source of truth
 * and a probe-based filter would be slow, rate-limit-confounded, and a de-facto
 * manual list.
 */
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
    const entries = raw
      .map(toEntry)
      .filter((e): e is CatalogueEntry => e !== null);

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
          name: DEFAULT_MODEL,
          contextLength: 0,
          promptPrice: "",
          completionPrice: "",
          vision: true,
        },
      ];
    }
    return rows
      .map(toPublic)
      .sort((a, b) => a.modelId.localeCompare(b.modelId));
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
