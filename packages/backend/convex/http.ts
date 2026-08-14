import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { polar } from "./subscriptions";

const http = httpRouter();

auth.addHttpRoutes(http);

// Register the webhook handler at /polar/events
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
polar.registerRoutes(http as any);

// --- Hybrid adapter WEBHOOK PATH: external backend posts results/events here ---
http.route({
  path: "/backend/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = req.headers.get("x-webhook-secret");
    if (!secret || secret !== process.env.BACKEND_WEBHOOK_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    const payload = (await req
      .json()
      .catch(() => ({}))) as Record<string, unknown>;
    const type = typeof payload.type === "string" ? payload.type : "event";

    if (type === "job.result" && typeof payload.jobId === "string") {
      await ctx.runMutation(internal.jobs.complete, {
        // biome-ignore lint/suspicious/noExplicitAny: id validated by Convex
        jobId: payload.jobId as any,
        result: payload.result,
        error: typeof payload.error === "string" ? payload.error : undefined,
      });
    } else {
      await ctx.runMutation(internal.backend.ingestEvent, {
        workspaceId:
          typeof payload.workspaceId === "string"
            ? // biome-ignore lint/suspicious/noExplicitAny: id validated by Convex
              (payload.workspaceId as any)
            : undefined,
        source: "backend",
        type,
        payload,
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
});

// --- AI inference plane ingress -------------------------------------------
//
// Deliberately a SEPARATE route and a SEPARATE secret from /backend/webhook:
//   * that handler falls through to internal.backend.ingestEvent, which would
//     write one `events` row per token batch and re-broadcast the whole
//     listEvents query to every dashboard subscriber — catastrophic;
//   * BACKEND_WEBHOOK_SECRET is held by the Node echo service on :4000, a
//     different process in a different trust domain. Sharing it would mean a
//     compromise there could forge chat deltas into arbitrary users' threads.
//
// Auth is layered: a constant-time secret check PLUS capability scoping. Every
// op carries a `streamId` UUID that Convex minted in messages.send, so even a
// leaked secret cannot target a conversation the caller doesn't already know.
const aiJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Constant-time compare. The existing webhook uses `!==`, which short-circuits. */
function timingSafeEqual(a: string | null, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorizeIngress(req: Request): boolean {
  return timingSafeEqual(
    req.headers.get("x-ai-key"),
    process.env.AI_INGRESS_SECRET,
  );
}

http.route({
  path: "/ai/ingress",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!authorizeIngress(req))
      return new Response("unauthorized", { status: 401 });

    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body.op !== "string")
      return aiJson({ error: "bad request" }, 400);

    const streamId = typeof body.streamId === "string" ? body.streamId : null;

    switch (body.op) {
      case "delta": {
        if (!streamId || !Array.isArray(body.deltas)) {
          return aiJson({ error: "bad request" }, 400);
        }
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
        if ("unknown" in r && r.unknown)
          return aiJson({ error: "unknown stream" }, 404);
        return aiJson(r);
      }
      case "heartbeat": {
        if (!streamId) return aiJson({ error: "bad request" }, 400);
        const r = await ctx.runMutation(internal.chat.ingest.heartbeat, {
          streamId,
        });
        if ("unknown" in r && r.unknown)
          return aiJson({ error: "unknown stream" }, 404);
        return aiJson(r);
      }
      case "finalize": {
        if (!streamId) return aiJson({ error: "bad request" }, 400);
        const status = body.status === "error" ? "error" : "done";
        const text = typeof body.text === "string" ? body.text : "";
        if (status === "error") {
          const err = (body.error ?? {}) as Record<string, unknown>;
          const r = await ctx.runMutation(internal.chat.ingest.failStream, {
            streamId,
            error:
              typeof err.message === "string"
                ? err.message
                : "Generation failed",
            errorCode: typeof err.code === "string" ? err.code : undefined,
            text,
          });
          if ("unknown" in r && r.unknown)
            return aiJson({ error: "unknown stream" }, 404);
          return aiJson(r);
        }
        const usage = (body.usage ?? {}) as Record<string, unknown>;
        const num = (x: unknown) => (typeof x === "number" ? x : undefined);
        const r = await ctx.runMutation(internal.chat.ingest.finishStream, {
          streamId,
          text,
          finishReason:
            typeof body.finishReason === "string"
              ? body.finishReason
              : undefined,
          reasoning:
            typeof body.reasoning === "string" ? body.reasoning : undefined,
          tokensIn: num(usage.promptTokens),
          tokensOut: num(usage.completionTokens),
          costUsd: num(usage.costUsd),
          firstTokenMs: num(body.firstTokenMs),
          latencyMs: num(body.latencyMs),
        });
        if ("unknown" in r && r.unknown)
          return aiJson({ error: "unknown stream" }, 404);
        return aiJson(r);
      }
      case "title": {
        if (!streamId || typeof body.title !== "string") {
          return aiJson({ error: "bad request" }, 400);
        }
        return aiJson(
          await ctx.runMutation(internal.chat.ingest.setTitle, {
            streamId,
            title: body.title,
          }),
        );
      }
      case "summary": {
        if (
          !streamId ||
          typeof body.summary !== "string" ||
          typeof body.throughSeq !== "number"
        ) {
          return aiJson({ error: "bad request" }, 400);
        }
        return aiJson(
          await ctx.runMutation(internal.chat.ingest.setSummary, {
            streamId,
            summary: body.summary,
            throughSeq: body.throughSeq,
          }),
        );
      }
      default:
        return aiJson({ error: `unknown op: ${body.op}` }, 400);
    }
  }),
});

// Attachment bytes for the inference plane.
//
// Python fetches through here rather than being handed ctx.storage.getUrl(),
// because that URL is a BEARER CAPABILITY — unguessable but not scoped and not
// reliably time-limited, so passing it around would leak it into request
// bodies, httpx logs and traces.
http.route({
  path: "/ai/file",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!authorizeIngress(req))
      return new Response("unauthorized", { status: 401 });
    const body = (await req.json().catch(() => null)) as {
      storageId?: string;
    } | null;
    if (!body?.storageId) return aiJson({ error: "bad request" }, 400);
    // biome-ignore lint/suspicious/noExplicitAny: id shape validated by storage
    const blob = await ctx.storage.get(body.storageId as any);
    if (!blob) return new Response("not found", { status: 404 });
    return new Response(blob);
  }),
});

// --- API key verification (programmatic access) ---
http.route({
  path: "/api/verify-key",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const key = req.headers.get("x-api-key") ?? "";
    const json = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (!key) return json({ valid: false }, 401);
    const buf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(key),
    );
    const hash = Array.from(new Uint8Array(buf), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const found = await ctx.runQuery(internal.apiKeys.resolveByHash, { hash });
    return json({ valid: !!found, ...(found ?? {}) }, found ? 200 : 401);
  }),
});

export default http;
