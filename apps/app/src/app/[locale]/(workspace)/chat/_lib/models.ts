/**
 * Client-side model helpers.
 *
 * The list itself is no longer here: it is fetched from OpenRouter, cached in
 * the `chatModels` table and read through `api.chat.models.list`. Only the two
 * things that must work WITHOUT a query survive in this module.
 */

/**
 * Mirrors DEFAULT_MODEL in convex/chat/authz.ts. Keep the ids in sync.
 *
 * These DRIFTED once, and the failure was invisible from either side: the
 * backend moved to deepseek-v4-pro when the gpt-5* family stopped serving, this
 * copy did not, and the picker went on seeding every session with a model that
 * had left the catalogue. On a new thread that id no longer matched
 * thread.model, so assertAllowedModel read it as a deliberate pick and threw
 * "Unsupported model" — chat was dead for anyone who had not manually chosen a
 * model, with nothing in the database to explain why. ModelPicker now also
 * corrects the selection once the catalogue loads, so a future drift degrades
 * instead of breaking.
 */
export const DEFAULT_MODEL = "deepseek-v4-pro";

/**
 * A readable name for a model id, derived purely from the string.
 *
 * This MUST stay synchronous and query-free. Its main caller is MessageBubble,
 * which is memoised with a custom comparator precisely because Convex hands
 * back fresh object identities on every push — giving it a `useQuery` would
 * re-render every message in the thread on every token.
 *
 * It used to return "Opus 5" for anything it did not recognise, which was
 * harmless against a hard-coded list of three and actively wrong against a
 * catalogue of several hundred: every model would have been labelled "Opus 5"
 * in both the picker trigger and the transcript.
 *
 *   anthropic/claude-opus-5  ->  Claude Opus 5
 *   openai/gpt-4o            ->  Gpt 4o
 *   openrouter/auto          ->  Auto
 */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return "Model";
  const slug = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  const words = slug
    .replace(/[-_.]+/g, " ")
    .replace(/:/g, " ")
    .trim()
    .split(/\s+/);
  if (words.length === 0) return id;
  return words
    .map((w) => (w.length > 0 ? w[0]?.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Per-million-token price for display, or null when it cannot be shown.
 *
 * OpenRouter reports "-1" for its five meta-routers (openrouter/auto, fusion,
 * …) where the real price depends on which model the router picks. Rendering
 * that arithmetically produces "-$1000000.00/1M", so those return null and the
 * UI says "variable" instead.
 */
export function pricePerMillion(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1_000_000;
}
