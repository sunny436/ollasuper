import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation } from "../_generated/server";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { EVENT_TYPES } from "./events";

/**
 * The HOT ingress ops — delta, event, heartbeat, finalize, and the scheduler
 * tick (sched-list / materialize / claim / heartbeat / verify) — reachable two ways:
 *
 *   1. `POST /ai/ingress` (http.ts): the HTTP action, as always.
 *   2. `chat/ingress:apply` via `POST /api/mutation`: the same logic as a
 *      guarded PUBLIC mutation.
 *
 * Why (2) exists. Measured on production (UDF execution stream, 24 h): the HTTP
 * action costs ~136 ms per POST of which the mutation it runs is ~11 ms — the
 * remaining ~125 ms is HTTP-action runtime overhead, present even when the
 * request is rejected with 401 before any mutation runs (106–143 ms on
 * loopback). A mutation over `/api/mutation` round-trips in 8–14 ms. At ~3
 * posts per second per stream that is the difference between a first token
 * that waits an extra eighth of a second and one that does not, and it removes
 * ~110 ms from every turn's finalize.
 *
 * SECURITY IS UNCHANGED. Both entry points run `authorizeIngressKey` — the same
 * constant-time comparison against `AI_INGRESS_SECRET` the HTTP action has
 * always done — and then the same capability-scoped mutations: every op names
 * a `streamId` that Convex minted inside messages.send, so a leaked key still
 * cannot target a conversation the caller does not already know. The key
 * travels in the mutation args exactly as it travelled in the `x-ai-key`
 * header: over loopback, never logged (Convex does not log function args), and
 * the mutation throws before touching the database when it does not match.
 * `/api/mutation` is reachable through the public `/__cvx` path the browser
 * uses, but so is `/__cvx-site/ai/ingress` — this adds no new surface.
 *
 * Only the hot ops are here on purpose. The ~20 remaining ops (artifacts,
 * MCP credentials, run control, …) are rare and stay on the HTTP action; a
 * case that runs several mutations in sequence keeps its per-call commit
 * semantics there rather than being folded into one transaction here.
 */
export const HOT_OPS = [
  "delta",
  "event",
  "heartbeat",
  "finalize",
  // The scheduler service's tick: one query/mutation each, and the single
  // largest source of HTTP-action calls on production (sched-materialize ran
  // ~0.7 times a second at ~142 ms each — a constant tenth of a core).
  "sched-list",
  "sched-materialize",
  "sched-claim",
  "sched-heartbeat",
  "sched-verify",
] as const;

/** Constant-time compare — the same check http.ts uses for every secret. */
export function timingSafeEqual(
  a: string | null | undefined,
  b: string | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authorizeIngressKey(key: string | null | undefined): boolean {
  return timingSafeEqual(key, process.env.AI_INGRESS_SECRET);
}

/** What an op answers with; the HTTP action turns it into a Response. */
export type IngressResult = { status: number; body: unknown };

const bad = (): IngressResult => ({ status: 400, body: { error: "bad request" } });
const unknownStream = (): IngressResult => ({
  status: 404,
  body: { error: "unknown stream" },
});
const ok = (body: unknown): IngressResult => ({ status: 200, body });

/**
 * Apply one hot op. `ctx` is either the HTTP action's ActionCtx or the public
 * mutation's MutationCtx — both provide `runMutation`, and the internal
 * mutations below are where every capability check lives (streamId → stream
 * row → thread), so the two entry points cannot diverge in what they allow.
 */
export async function applyHotOp(
  ctx:
    | Pick<ActionCtx, "runMutation" | "runQuery">
    | Pick<MutationCtx, "runMutation" | "runQuery">,
  body: Record<string, unknown>,
): Promise<IngressResult | null> {
  const streamId = typeof body.streamId === "string" ? body.streamId : null;
  switch (body.op) {
    case "delta": {
      if (!streamId || !Array.isArray(body.deltas)) return bad();
      const deltas = body.deltas
        .filter(
          (d): d is { seq: number; text: string } =>
            typeof d === "object" &&
            d !== null &&
            typeof (d as { seq?: unknown }).seq === "number" &&
            typeof (d as { text?: unknown }).text === "string",
        )
        .map((d) => ({ seq: d.seq, text: d.text }));
      const r = await ctx.runMutation(internal.chat.ingest.appendDeltas, {
        streamId,
        deltas,
      });
      // Unknown streamId => 404 and nothing written. Proves capability scoping.
      if ("unknown" in r && r.unknown) return unknownStream();
      return ok(r);
    }
    case "heartbeat": {
      if (!streamId) return bad();
      const r = await ctx.runMutation(internal.chat.ingest.heartbeat, {
        streamId,
      });
      if ("unknown" in r && r.unknown) return unknownStream();
      return ok(r);
    }
    case "event": {
      // Typed events (Phase 3). Defensively filter to well-formed events with
      // a KNOWN type — malformed/unknown-type events are dropped at the edge
      // (mirrors the delta filter) so the mutation validator never sees bad
      // data. Scoped by the same streamId capability; nothing is executed.
      if (!streamId || !Array.isArray(body.events)) return bad();
      const events = body.events
        .filter(
          (e): e is Record<string, unknown> =>
            typeof e === "object" && e !== null,
        )
        .filter(
          (e) =>
            typeof e.eventId === "string" &&
            typeof e.seq === "number" &&
            typeof e.type === "string" &&
            (EVENT_TYPES as readonly string[]).includes(e.type) &&
            typeof e.payload === "string",
        )
        .map((e) => ({
          eventId: e.eventId as string,
          seq: e.seq as number,
          type: e.type as (typeof EVENT_TYPES)[number],
          v: typeof e.v === "number" ? (e.v as number) : 1,
          ts: typeof e.ts === "number" ? (e.ts as number) : Date.now(),
          textOffset:
            typeof e.textOffset === "number"
              ? (e.textOffset as number)
              : undefined,
          payload: e.payload as string,
        }));
      const r = await ctx.runMutation(internal.chat.ingest.appendEvent, {
        streamId,
        events,
      });
      if ("unknown" in r && r.unknown) return unknownStream();
      return ok(r);
    }
    case "finalize": {
      if (!streamId) return bad();
      // "cancelled" must NOT fall through to "done". When the user pressed
      // Stop, stop() has already marked the stream aborted and finishStream
      // short-circuits — but registry.shutdown() also cancels every in-flight
      // task on a graceful systemd restart, and there the stream is still
      // running. Mapping that to "done" would silently persist a truncated
      // answer labelled complete, with no error badge, that retry() refuses
      // because it only accepts error/aborted.
      const status =
        body.status === "error" || body.status === "cancelled"
          ? "error"
          : "done";
      // Which model the Master Model Router actually ran, and why. Both
      // branches persist it: a failed turn names its model or the router
      // learns nothing from the failure.
      const routedModel =
        typeof body.model === "string" && body.model ? body.model : undefined;
      const routedReason =
        typeof body.routedReason === "string" && body.routedReason
          ? body.routedReason
          : undefined;
      const text = typeof body.text === "string" ? body.text : "";
      if (status === "error") {
        const err = (body.error ?? {}) as Record<string, unknown>;
        const cancelled = body.status === "cancelled";
        const r = await ctx.runMutation(internal.chat.ingest.failStream, {
          streamId,
          error: cancelled
            ? "Response was interrupted"
            : typeof err.message === "string"
              ? err.message
              : "Generation failed",
          errorCode: cancelled
            ? "interrupted"
            : typeof err.code === "string"
              ? err.code
              : undefined,
          text,
          model: routedModel,
          routedReason,
        });
        if ("unknown" in r && r.unknown) return unknownStream();
        return ok(r);
      }
      const usage = (body.usage ?? {}) as Record<string, unknown>;
      const num = (x: unknown) => (typeof x === "number" ? x : undefined);
      const r = await ctx.runMutation(internal.chat.ingest.finishStream, {
        streamId,
        text,
        model: routedModel,
        routedReason,
        finishReason:
          typeof body.finishReason === "string" ? body.finishReason : undefined,
        reasoning:
          typeof body.reasoning === "string" ? body.reasoning : undefined,
        tokensIn: num(usage.promptTokens),
        tokensOut: num(usage.completionTokens),
        costUsd: num(usage.costUsd),
        firstTokenMs: num(body.firstTokenMs),
        latencyMs: num(body.latencyMs),
      });
      if ("unknown" in r && r.unknown) return unknownStream();
      return ok(r);
    }
    case "sched-list": {
      const limit = typeof body.limit === "number" ? body.limit : undefined;
      return ok(
        await ctx.runQuery(internal.scheduled.occurrences.listSchedulable, {
          limit,
        }),
      );
    }
    case "sched-materialize": {
      const taskId = typeof body.taskId === "string" ? body.taskId : null;
      const fromCursor =
        typeof body.fromCursor === "number" ? body.fromCursor : null;
      const toCursor = typeof body.toCursor === "number" ? body.toCursor : null;
      if (!taskId || fromCursor === null || toCursor === null) return bad();
      const scheduledFor = Array.isArray(body.scheduledFor)
        ? body.scheduledFor.filter((x): x is number => typeof x === "number")
        : [];
      return ok(
        await ctx.runMutation(internal.scheduled.occurrences.materialize, {
          taskId,
          fromCursor,
          toCursor,
          scheduledFor,
          nextRunAt:
            typeof body.nextRunAt === "number" ? body.nextRunAt : undefined,
          invalidReason:
            typeof body.invalidReason === "string"
              ? body.invalidReason
              : undefined,
          scheduleEnded: body.scheduleEnded === true ? true : undefined,
        }),
      );
    }
    case "sched-claim": {
      const limit = typeof body.limit === "number" ? body.limit : 5;
      const maxPerUser =
        typeof body.maxPerUser === "number" ? body.maxPerUser : 1;
      return ok(
        await ctx.runMutation(internal.scheduled.occurrences.claim, {
          limit,
          maxPerUser,
        }),
      );
    }
    case "sched-verify":
    case "sched-heartbeat": {
      const occurrenceKey =
        typeof body.occurrenceKey === "string" ? body.occurrenceKey : null;
      const leaseToken =
        typeof body.leaseToken === "string" ? body.leaseToken : null;
      if (!occurrenceKey || !leaseToken) return bad();
      if (body.op === "sched-heartbeat") {
        return ok(
          await ctx.runMutation(internal.scheduled.occurrences.heartbeat, {
            occurrenceKey,
            leaseToken,
          }),
        );
      }
      return ok(
        await ctx.runMutation(internal.scheduled.occurrences.verify, {
          occurrenceKey,
          leaseToken,
          workflowId:
            typeof body.workflowId === "string" ? body.workflowId : undefined,
        }),
      );
    }
    default:
      return null; // not a hot op — the HTTP action handles the rest
  }
}

/**
 * The guarded public mutation. Throws (before any read) unless `key` matches
 * `AI_INGRESS_SECRET`; refuses anything but a hot op so the two entry points
 * stay identical in what they can do. The body is validated by the same
 * per-op filters as the HTTP action, inside applyHotOp.
 */
export const apply = mutation({
  args: { key: v.string(), body: v.any() },
  handler: async (ctx, { key, body }): Promise<IngressResult> => {
    if (!authorizeIngressKey(key)) throw new ConvexError("unauthorized");
    if (!body || typeof body !== "object" || typeof body.op !== "string") {
      return bad();
    }
    if (!(HOT_OPS as readonly string[]).includes(body.op)) {
      return { status: 400, body: { error: "not a hot op" } };
    }
    const r = await applyHotOp(ctx, body as Record<string, unknown>);
    return r ?? bad();
  },
});
