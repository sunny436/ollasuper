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
 * The OpenRouter model catalogue.
 *
 * WHY A CACHED TABLE RATHER THAN A LIVE FETCH:
 * `assertAllowedModel` runs inside mutations, and Convex mutations cannot do
 * network I/O. Validation therefore has to read the allow-list out of the
 * database, which means something has to put it there — hence
 * internalAction (fetch) -> internalMutation (write) -> query (read), the same
 * shape chat/stream.ts already uses for dispatch.
 *
 * WHY /models/user AND NOT /models:
 * `/api/v1/models` returns an identical payload with or without credentials, so
 * it answers "what does OpenRouter offer", not "what can this key reach".
 * `/api/v1/models/user` is the account-filtered list and is the only one that
 * honours the account's provider preferences. Measured difference at the time
 * of writing: 414 vs 411.
 */

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models/user";

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

interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
  pricing?: { prompt?: unknown; completion?: unknown };
}

export interface CatalogueEntry {
  modelId: string;
  name: string;
  contextLength: number;
  promptPrice: string;
  completionPrice: string;
  vision: boolean;
}

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Keep only models that can actually hold a text conversation.
 *
 * Every entry the endpoint returns today already qualifies, so this currently
 * drops nothing — it is a guard against OpenRouter later listing image- or
 * audio-only models on the same endpoint, which would otherwise appear in the
 * picker and fail at generation instead of at selection.
 */
function toEntry(m: OpenRouterModel): CatalogueEntry | null {
  if (typeof m.id !== "string" || !m.id) return null;
  const input = asStrings(m.architecture?.input_modalities);
  const output = asStrings(m.architecture?.output_modalities);
  if (!input.includes("text") || !output.includes("text")) return null;

  return {
    modelId: m.id,
    name: typeof m.name === "string" && m.name ? m.name : m.id,
    contextLength:
      typeof m.context_length === "number" && m.context_length > 0
        ? m.context_length
        : 0,
    promptPrice: String(m.pricing?.prompt ?? ""),
    completionPrice: String(m.pricing?.completion ?? ""),
    vision: input.includes("image"),
  };
}

/** Fetch + filter. Exported for the write mutation; never returns the key. */
export const refresh = internalAction({
  args: {},
  handler: async (ctx): Promise<{ fetched: number; kept: number; applied: boolean }> => {
    const key = process.env.OPENROUTER_API_KEY;
    // Hard-fail at the call site rather than in env.ts: the deployment runs
    // with VALIDATE_ENV=true, so declaring this required there would break the
    // backend the moment this lands but before the key is set. Same reasoning
    // as AI_BASE_URL.
    if (!key) throw new Error("OPENROUTER_API_KEY is not set on this deployment");

    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      throw new Error(`OpenRouter responded ${res.status}`);
    }
    const body = (await res.json()) as { data?: OpenRouterModel[] };
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
