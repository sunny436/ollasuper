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
      case "file": {
        // File-ingestion status callback. Scoped by the ingestId capability
        // (body.fileId), not streamId — the streamId parsed above is unused here.
        const fileId = typeof body.fileId === "string" ? body.fileId : null;
        const status =
          body.status === "ready"
            ? "ready"
            : body.status === "failed"
              ? "failed"
              : null;
        if (!fileId || !status) return aiJson({ error: "bad request" }, 400);
        const num = (x: unknown) => (typeof x === "number" ? x : undefined);
        const str = (x: unknown) => (typeof x === "string" ? x : undefined);
        const r = await ctx.runMutation(internal.userFiles.setStatus, {
          fileId,
          status,
          chunkCount: num(body.chunkCount),
          parserUsed: str(body.parserUsed),
          pageCount: num(body.pageCount),
          detectedType: str(body.detectedType),
          contentHash: str(body.contentHash),
          error: str(body.error),
          note: str(body.note),
        });
        if ("unknown" in r && r.unknown)
          return aiJson({ error: "unknown file" }, 404);
        return aiJson(r);
      }
      case "file-progress": {
        // Intermediate ingestion progress (status stays `processing`). Same
        // ingestId capability as "file"; best-effort, so an unknown file is a
        // benign no-op rather than an error.
        const fileId = typeof body.fileId === "string" ? body.fileId : null;
        const stage = typeof body.stage === "string" ? body.stage : null;
        if (!fileId || !stage) return aiJson({ error: "bad request" }, 400);
        const num = (x: unknown) => (typeof x === "number" ? x : undefined);
        const str = (x: unknown) => (typeof x === "string" ? x : undefined);
        const r = await ctx.runMutation(internal.userFiles.setProgress, {
          fileId,
          stage,
          progress: num(body.progress),
          processedUnits: num(body.processedUnits),
          totalUnits: num(body.totalUnits),
          stageMessage: str(body.stageMessage),
        });
        return aiJson(r);
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
//
// CAPABILITY-SCOPED, like every other ingress op. An earlier version took a
// bare storageId, which made AI_INGRESS_SECRET a key to every blob in the
// deployment — the workspace files plane, every user's private chat
// attachments, avatars — and quietly undid the "storageId is never exposed"
// discipline in chat/attachments.ts. The caller must now also present the
// streamId it was given, and the blob must belong to an attachment on that
// stream's own thread.
http.route({
  path: "/ai/file",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!authorizeIngress(req))
      return new Response("unauthorized", { status: 401 });
    const body = (await req.json().catch(() => null)) as {
      storageId?: string;
      streamId?: string;
    } | null;
    if (!body?.storageId || !body?.streamId) {
      return aiJson({ error: "bad request" }, 400);
    }

    const allowed = await ctx.runQuery(
      internal.chat.stream.attachmentInStream,
      { streamId: body.streamId, storageId: body.storageId },
    );
    // Same response for "no such blob" and "not yours" — no existence oracle.
    if (!allowed) return new Response("not found", { status: 404 });

    const blob = await ctx.storage.get(allowed.storageId);
    if (!blob) return new Response("not found", { status: 404 });
    return new Response(blob);
  }),
});

// Staging-blob bytes for the File Knowledge System ingestion.
//
// A SEPARATE route from /ai/file, not a branch on it: each keeps a single
// capability contract. Here the capability is the ingestId (an unguessable UUID
// minted in userFiles.saveFile); the storageId is resolved server-side and never
// crosses to Python. Same x-ai-key gate + no-existence-oracle 404 as /ai/file.
http.route({
  path: "/ai/ingest-file",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!authorizeIngress(req))
      return new Response("unauthorized", { status: 401 });
    const body = (await req.json().catch(() => null)) as {
      fileId?: string;
    } | null;
    if (!body?.fileId) return aiJson({ error: "bad request" }, 400);
    const allowed = await ctx.runQuery(internal.userFiles.stagingBlobForFile, {
      fileId: body.fileId,
    });
    if (!allowed) return new Response("not found", { status: 404 });
    const blob = await ctx.storage.get(allowed.storageId);
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

// --- Public shared-attachment proxy (revocable) ---
//
// Serves an attachment that belongs to a share's frozen snapshot, but ONLY while
// the share is live: chat/shares.resolveAttachment returns null once the share is
// revoked or expired, so this 404s (same response for missing/expired/revoked —
// no existence oracle). Public (no ingress secret): access is gated entirely by
// the unguessable token + the snapshot membership check. storageId never leaves
// the server; only this share's own attachments are ever reachable — never the
// user's file library.
http.route({
  path: "/share/file",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const token = url.searchParams.get("t");
    const m = Number(url.searchParams.get("m"));
    const a = Number(url.searchParams.get("a"));
    if (!token || !Number.isInteger(m) || !Number.isInteger(a)) {
      return new Response("not found", { status: 404 });
    }
    const allowed = await ctx.runQuery(internal.chat.shares.resolveAttachment, {
      token,
      m,
      a,
    });
    if (!allowed) return new Response("not found", { status: 404 });
    const blob = await ctx.storage.get(allowed.storageId);
    if (!blob) return new Response("not found", { status: 404 });
    return new Response(blob, {
      headers: {
        "content-type": allowed.contentType,
        "cache-control": "private, max-age=300",
      },
    });
  }),
});

export default http;
