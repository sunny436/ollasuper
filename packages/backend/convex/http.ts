import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { EVENT_TYPES } from "./chat/events";
import { applyHotOp, authorizeIngressKey, timingSafeEqual } from "./chat/ingress";
import { env } from "./env";
import { polar } from "./subscriptions";
import { isInlineSafeImageType, neutralizedBlobType } from "./blobSafety";
import { contentDisposition, inlineImageType } from "./fileKind";

const http = httpRouter();

/**
 * The OIDC discovery + JWKS routes, with a cache lifetime the backend can use.
 *
 * `@convex-dev/auth` serves both with `Cache-Control: max-age=15`, and the Convex
 * backend honours that header when it validates a JWT: every token check that
 * lands more than 15 s after the previous one re-fetches BOTH documents through
 * `CONVEX_SITE_URL` — the public hostname, i.e. out through Cloudflare and back
 * in through the tunnel. Measured on production: 137 ms + 126 ms, sequential,
 * with no request coalescing (72 of 249 refetches in one day were <1 s apart),
 * and 216 of the 220 middleware auth checks that took 200-500 ms coincided with
 * one. That was ~15 % of every page/RSC request and every WebSocket
 * re-authentication.
 *
 * The bodies below are byte-identical to the library's (same env vars, same
 * fields); only `max-age` changes, and it is a runtime knob:
 * `AUTH_WELLKNOWN_MAX_AGE_S` (default 3600) — `convex env set` it to 15 to get
 * the library's behaviour back with no redeploy.
 *
 * SECURITY: caching a PUBLIC key longer does not weaken validation — the
 * signature check, issuer and key are unchanged, and the library itself already
 * permits a day-old JWKS under `stale-if-error=86400`. What changes is key
 * ROTATION: the JWKS carries no `kid`, so after setting a new `JWT_PRIVATE_KEY`
 * + `JWKS`, RESTART THE BACKEND CONTAINER to drop its cached copy (with 15 s the
 * cache expired on its own). Old-key tokens are rejected as soon as the cache
 * refreshes; the refresh-token flow re-issues under the new key, as before.
 */
const WELLKNOWN_DEFAULT_MAX_AGE_S = 3600;

function wellKnownCacheControl(): string {
  const raw = Number(process.env.AUTH_WELLKNOWN_MAX_AGE_S);
  const maxAge =
    Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : WELLKNOWN_DEFAULT_MAX_AGE_S;
  return `public, max-age=${maxAge}, stale-while-revalidate=300, stale-if-error=86400`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Missing environment variable \`${name}\``);
  return value;
}

http.route({
  path: "/.well-known/openid-configuration",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(
      JSON.stringify({
        issuer: requireEnv("CONVEX_SITE_URL"),
        jwks_uri: `${requireEnv("CONVEX_SITE_URL")}/.well-known/jwks.json`,
        authorization_endpoint: `${requireEnv("CONVEX_SITE_URL")}/oauth/authorize`,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": wellKnownCacheControl(),
        },
      },
    );
  }),
});

http.route({
  path: "/.well-known/jwks.json",
  method: "GET",
  handler: httpAction(async () => {
    return new Response(requireEnv("JWKS"), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": wellKnownCacheControl(),
      },
    });
  }),
});

// The library registers the two routes above itself and the router throws on a
// duplicate path, so it gets a shim that drops just those two and forwards
// everything else (the OAuth sign-in/callback routes) unchanged.
const WELLKNOWN_PATHS = new Set([
  "/.well-known/openid-configuration",
  "/.well-known/jwks.json",
]);
auth.addHttpRoutes({
  route: (spec: Parameters<typeof http.route>[0]) => {
    if ("path" in spec && WELLKNOWN_PATHS.has(spec.path)) return;
    http.route(spec);
  },
} as typeof http);

// Register the webhook handler at /polar/events
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
polar.registerRoutes(http as any);

// --- Hybrid adapter WEBHOOK PATH: external backend posts results/events here ---
http.route({
  path: "/backend/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    // Constant-time, like every other secret check in this file. A plain !==
    // short-circuits on the first differing byte; the helper is defined above
    // and its own comment named this handler as the one that ignored it.
    const secret = req.headers.get("x-webhook-secret");
    if (!timingSafeEqual(secret, process.env.BACKEND_WEBHOOK_SECRET)) {
      return new Response("unauthorized", { status: 401 });
    }
    const payload = (await req
      .json()
      .catch(() => ({}))) as Record<string, unknown>;
    const type = typeof payload.type === "string" ? payload.type : "event";

    // The TENANT is never taken from the payload (audit F-10). The secret
    // authenticates the SERVICE, not whoever supplied the body it relays; a
    // caller-chosen workspaceId let any payload the legacy backend forwarded
    // land in another workspace's event feed. With no server-side
    // authorization decision to derive a workspace from, the event is stored
    // unscoped — visible to no workspace's listEvents.
    await ctx.runMutation(internal.backend.ingestEvent, {
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

// timingSafeEqual (used by every secret check in this file) and the ingress
// key check are shared with chat/ingress.ts so both entry points cannot drift.
function authorizeIngress(req: Request): boolean {
  return authorizeIngressKey(req.headers.get("x-ai-key"));
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

    // delta / event / heartbeat / finalize live in chat/ingress.ts, shared with
    // the guarded public mutation `chat/ingress:apply` (the ~10 ms path the
    // Python plane prefers over this ~136 ms HTTP action; see that file).
    const hot = await applyHotOp(ctx, body);
    if (hot) return aiJson(hot.body, hot.status);

    switch (body.op) {
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
      case "suggestions": {
        if (!streamId || !Array.isArray(body.suggestions)) {
          return aiJson({ error: "bad request" }, 400);
        }
        return aiJson(
          await ctx.runMutation(internal.chat.ingest.setSuggestions, {
            streamId,
            suggestions: body.suggestions
              .filter((s: unknown): s is string => typeof s === "string")
              .slice(0, 3),
          }),
        );
      }
      // ---- conversational context (platform layer) ----
      //
      // Keyed on the stream like every other op, which is also the
      // authorization: the artifact is registered against the message THIS
      // turn is writing, so a turn cannot register work against someone
      // else's message or another thread.
      case "artifact": {
        if (
          !streamId ||
          typeof body.kind !== "string" ||
          typeof body.subject !== "string"
        ) {
          return aiJson({ error: "bad request" }, 400);
        }
        return aiJson(
          await ctx.runMutation(internal.chat.context.registerArtifact, {
            streamId,
            kind: body.kind.slice(0, 40),
            subject: body.subject.slice(0, 200),
            ...(typeof body.supersedesArtifactId === "string"
              ? { supersedesArtifactId: body.supersedesArtifactId }
              : {}),
          }),
        );
      }
      case "artifact-revert": {
        if (!streamId || typeof body.artifactId !== "string") {
          return aiJson({ error: "bad request" }, 400);
        }
        return aiJson(
          await ctx.runMutation(internal.chat.context.revertArtifact, {
            streamId,
            artifactId: body.artifactId,
            ...(typeof body.toVersion === "number"
              ? { toVersion: body.toVersion }
              : {}),
          }),
        );
      }
      case "context-state": {
        if (!streamId || typeof body.throughSeq !== "number") {
          return aiJson({ error: "bad request" }, 400);
        }
        // Only the fields actually supplied are forwarded. An absent
        // enrichment field leaves the stored value standing rather than
        // clearing it — a model that says nothing must not be able to erase
        // a constraint the user set several turns ago.
        const strList = (x: unknown): string[] | undefined =>
          Array.isArray(x)
            ? x.filter((s): s is string => typeof s === "string").slice(0, 24)
            : undefined;
        return aiJson(
          await ctx.runMutation(internal.chat.context.applyContextWrite, {
            streamId,
            throughSeq: body.throughSeq,
            ...(typeof body.operation === "string"
              ? { operation: body.operation.slice(0, 40) }
              : {}),
            ...(typeof body.activeArtifactId === "string"
              ? { activeArtifactId: body.activeArtifactId }
              : {}),
            ...(typeof body.activeArtifactVersion === "number"
              ? { activeArtifactVersion: body.activeArtifactVersion }
              : {}),
            ...(typeof body.activeSubject === "string"
              ? { activeSubject: body.activeSubject.slice(0, 200) }
              : {}),
            ...(strList(body.userConstraints)
              ? { userConstraints: strList(body.userConstraints) }
              : {}),
            ...(strList(body.userDecisions)
              ? { userDecisions: strList(body.userDecisions) }
              : {}),
            ...(strList(body.openLoops)
              ? { openLoops: strList(body.openLoops) }
              : {}),
          }),
        );
      }
      case "seo-mutation-result": {
        // Phase 7: the auditable RESULT of one APPROVED SEO write (before→write→verify→
        // rollback already done by the Python SeoWriteAdapter). Owner DERIVED from the
        // stream (like op:"execution"); idempotent by approvalId. Coerce + validate the
        // enum literals at the edge so the mutation validator never sees bad data.
        const ACTIONS = [
          "update_metadata",
          "update_structured_data",
          "propose_redirect",
          "update_content",
        ] as const;
        const STATUSES = [
          "succeeded",
          "failed",
          "verification_failed",
          "precondition_failed",
          "rolled_back",
          "rollback_failed",
        ] as const;
        const ROLLBACKS = ["none", "not_needed", "succeeded", "failed"] as const;
        if (
          !streamId ||
          typeof body.approvalId !== "string" ||
          typeof body.action !== "string" ||
          !(ACTIONS as readonly string[]).includes(body.action) ||
          typeof body.status !== "string" ||
          !(STATUSES as readonly string[]).includes(body.status) ||
          typeof body.rollbackStatus !== "string" ||
          !(ROLLBACKS as readonly string[]).includes(body.rollbackStatus)
        ) {
          return aiJson({ error: "bad request" }, 400);
        }
        const optStr = (x: unknown) =>
          typeof x === "string" ? x : undefined;
        const r = await ctx.runMutation(internal.seoMutations.recordResult, {
          streamId,
          approvalId: body.approvalId,
          executionId: optStr(body.executionId),
          toolId: typeof body.toolId === "string" ? body.toolId : "",
          action: body.action as (typeof ACTIONS)[number],
          target: typeof body.target === "string" ? body.target : "",
          provider: typeof body.provider === "string" ? body.provider : "",
          argsHash: typeof body.argsHash === "string" ? body.argsHash : "",
          reversibility:
            body.reversibility === "irreversible"
              ? "irreversible"
              : "reversible",
          estimatedCost: optStr(body.estimatedCost),
          status: body.status as (typeof STATUSES)[number],
          before: optStr(body.before),
          after: optStr(body.after),
          verification: optStr(body.verification),
          rollbackStatus: body.rollbackStatus as (typeof ROLLBACKS)[number],
        });
        if ("unknown" in r && r.unknown)
          return aiJson({ error: "unknown stream" }, 404);
        return aiJson(r);
      }
      case "research-checkpoint": {
        // Deep Research: persist ONE unit of durable research state (plan / finding /
        // complete) from the agent's `record_research` tool. Owner DERIVED from the
        // stream; idempotent by researchRunId. The nested payload is stringified +
        // bounded at the edge so the mutation validator only ever sees a string
        // (no v.any(), no payload-shape push on the live backend).
        const KINDS = ["plan", "finding", "complete"] as const;
        if (
          !streamId ||
          typeof body.researchRunId !== "string" ||
          typeof body.kind !== "string" ||
          !(KINDS as readonly string[]).includes(body.kind)
        ) {
          return aiJson({ error: "bad request" }, 400);
        }
        let payloadJson = "{}";
        try {
          payloadJson = JSON.stringify(body.payload ?? {}).slice(0, 24_000);
        } catch {
          payloadJson = "{}";
        }
        const r = await ctx.runMutation(internal.researchRuns.checkpoint, {
          streamId,
          researchRunId: body.researchRunId,
          kind: body.kind as (typeof KINDS)[number],
          payloadJson,
        });
        if ("unknown" in r && r.unknown)
          return aiJson({ error: "unknown stream" }, 404);
        return aiJson(r);
      }
      case "execution": {
        // Phase 3: durable per-execution record (crash-recovery authority). Coerce
        // + validate the state literal at the edge (mirrors the "event" filter) so
        // the mutation validator never sees bad data.
        const EXEC_STATES = [
          "pending",
          "running",
          "waiting_approval",
          "succeeded",
          "failed",
          "cancelled",
          "timed_out",
          "indeterminate",
          "deduped",
        ] as const;
        if (
          !streamId ||
          typeof body.executionId !== "string" ||
          typeof body.state !== "string" ||
          !(EXEC_STATES as readonly string[]).includes(body.state)
        ) {
          return aiJson({ error: "bad request" }, 400);
        }
        const r = await ctx.runMutation(
          internal.chat.executions.upsertExecution,
          {
            streamId,
            executionId: body.executionId,
            stepId: typeof body.stepId === "string" ? body.stepId : "",
            parentStep:
              typeof body.parentStep === "string" ? body.parentStep : undefined,
            toolCallId:
              typeof body.toolCallId === "string" ? body.toolCallId : "",
            toolId: typeof body.toolId === "string" ? body.toolId : "",
            attemptId:
              typeof body.attemptId === "string" ? body.attemptId : "",
            attempt: typeof body.attempt === "number" ? body.attempt : 0,
            actionType:
              typeof body.actionType === "string" ? body.actionType : "tool",
            sideEffect:
              typeof body.sideEffect === "string"
                ? body.sideEffect
                : "read_only",
            state: body.state as (typeof EXEC_STATES)[number],
            inputHash:
              typeof body.inputHash === "string" ? body.inputHash : "",
            args: body.args,
            resultContent:
              typeof body.resultContent === "string"
                ? body.resultContent
                : undefined,
            error: typeof body.error === "string" ? body.error : undefined,
            approvalRef:
              typeof body.approvalRef === "string"
                ? body.approvalRef
                : undefined,
            createdAt:
              typeof body.createdAt === "number" ? body.createdAt : Date.now(),
            startedAt:
              typeof body.startedAt === "number" ? body.startedAt : undefined,
            endedAt:
              typeof body.endedAt === "number" ? body.endedAt : undefined,
          },
        );
        if ("unknown" in r && r.unknown)
          return aiJson({ error: "unknown stream" }, 404);
        return aiJson(r);
      }
      case "approval": {
        // Phase 8: a tool parked awaiting user approval. Carries the stable
        // approvalId + the embedded APPROVAL_REQUEST event (filtered like
        // `event`). The response hands back any already-resolved decision so a
        // live run can act inline instead of suspending.
        if (
          !streamId ||
          typeof body.approvalId !== "string" ||
          typeof body.toolId !== "string" ||
          typeof body.event !== "object" ||
          body.event === null
        ) {
          return aiJson({ error: "bad request" }, 400);
        }
        const e = body.event as Record<string, unknown>;
        if (
          typeof e.eventId !== "string" ||
          typeof e.seq !== "number" ||
          e.type !== "APPROVAL_REQUEST" ||
          typeof e.payload !== "string"
        ) {
          return aiJson({ error: "bad request" }, 400);
        }
        const r = await ctx.runMutation(
          internal.chat.approvals.requestApproval,
          {
            streamId,
            approvalId: body.approvalId,
            toolId: body.toolId,
            toolName:
              typeof body.toolName === "string" ? body.toolName : "action",
            argsKey: typeof body.argsKey === "string" ? body.argsKey : "",
            reason: typeof body.reason === "string" ? body.reason : "",
            ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : 900_000,
            event: {
              eventId: e.eventId,
              seq: e.seq,
              type: "APPROVAL_REQUEST" as const,
              v: typeof e.v === "number" ? e.v : 1,
              ts: typeof e.ts === "number" ? e.ts : Date.now(),
              textOffset:
                typeof e.textOffset === "number" ? e.textOffset : undefined,
              payload: e.payload,
            },
          },
        );
        if ("unknown" in r && r.unknown)
          return aiJson({ error: "unknown stream" }, 404);
        return aiJson(r);
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
      case "remember": {
        // Phase 6: a memory candidate from the agent. Coerce kind/source/scope
        // to valid literals AT THE EDGE (the event-case discipline) so the
        // mutation arg-validator never sees bad data (which would 4xx). Scoped
        // by the streamId capability — Convex derives ownership from the stream.
        const content =
          typeof body.content === "string" ? body.content : null;
        if (!streamId || !content) return aiJson({ error: "bad request" }, 400);
        const KINDS = [
          "preference",
          "instruction",
          "fact",
          "project_context",
        ] as const;
        const kind = (
          typeof body.kind === "string" &&
          (KINDS as readonly string[]).includes(body.kind)
            ? body.kind
            : "fact"
        ) as (typeof KINDS)[number];
        const source =
          body.source === "explicit" || body.source === "inferred"
            ? body.source
            : undefined;
        // DELIBERATELY NOT "project". Project scope is derived in the mutation
        // from the stream's thread; letting the inference plane name it here
        // would hand an untrusted caller the ability to choose which Project a
        // memory lands in. A body-supplied scope:"project" falls through to
        // undefined and the mutation decides.
        const scope =
          body.scope === "user" || body.scope === "workspace"
            ? body.scope
            : undefined;
        const reason =
          typeof body.reason === "string"
            ? body.reason.slice(0, 500)
            : undefined;
        const r = await ctx.runMutation(
          internal.memories.rememberFromIngress,
          { streamId, content, kind, source, scope, reason },
        );
        if ("unknown" in r && r.unknown)
          return aiJson({ error: "unknown stream" }, 404);
        return aiJson(r);
      }
      case "forget": {
        // Phase 6: disable the agent-named memories. Ownership is re-checked in
        // the mutation (own-user, active rows only); ids come from the pre-loaded
        // pool. Coerce to a string[] at the edge before the id validator.
        const ids = Array.isArray(body.memoryIds)
          ? (body.memoryIds.filter(
              (x) => typeof x === "string",
            ) as Id<"userMemories">[])
          : [];
        if (!streamId || ids.length === 0)
          return aiJson({ error: "bad request" }, 400);
        const r = await ctx.runMutation(internal.memories.forgetFromIngress, {
          streamId,
          memoryIds: ids,
        });
        if ("unknown" in r && r.unknown)
          return aiJson({ error: "unknown stream" }, 404);
        return aiJson(r);
      }
      // ── Scheduled Tasks (Phase 1) ─────────────────────────────────────────
      // The scheduler process (services/ai/app/scheduler, DBOS) drives these.
      // They are occurrence-scoped, not stream-scoped, and deliberately return
      // NO task prompt or title: AI_INGRESS_SECRET must not become a cross-user
      // read capability over everyone's standing scheduled prompts.
      case "sched-finalize": {
        const occurrenceKey =
          typeof body.occurrenceKey === "string" ? body.occurrenceKey : null;
        const leaseToken =
          typeof body.leaseToken === "string" ? body.leaseToken : null;
        const outcome = body.outcome;
        if (
          !occurrenceKey ||
          !leaseToken ||
          (outcome !== "succeeded" &&
            outcome !== "failed" &&
            outcome !== "cancelled")
        ) {
          return aiJson({ error: "bad request" }, 400);
        }
        return aiJson(
          await ctx.runMutation(internal.scheduled.occurrences.finalize, {
            occurrenceKey,
            leaseToken,
            outcome,
            errorCode:
              typeof body.errorCode === "string" ? body.errorCode : undefined,
            retryable:
              typeof body.retryable === "boolean" ? body.retryable : undefined,
          }),
        );
      }
      // ── Scheduled Tasks execution (Phase 2) ───────────────────────────────
      // Occurrence-scoped and lease-guarded, exactly like the Phase 1 ops. They
      // return NO task content: the prompt reaches the model through the normal
      // dispatchPayload path, not through this surface.
      case "sched-start-run":
      case "sched-run-status":
      case "sched-cancel-run": {
        const occurrenceKey =
          typeof body.occurrenceKey === "string" ? body.occurrenceKey : null;
        const leaseToken =
          typeof body.leaseToken === "string" ? body.leaseToken : null;
        if (!occurrenceKey || !leaseToken) {
          return aiJson({ error: "bad request" }, 400);
        }
        if (body.op === "sched-run-status") {
          return aiJson(
            await ctx.runMutation(internal.scheduled.execution.runStatus, {
              occurrenceKey,
              leaseToken,
            }),
          );
        }
        if (body.op === "sched-cancel-run") {
          return aiJson(
            await ctx.runMutation(internal.scheduled.execution.cancelRun, {
              occurrenceKey,
              leaseToken,
            }),
          );
        }
        return aiJson(
          await ctx.runMutation(internal.scheduled.execution.startRun, {
            occurrenceKey,
            leaseToken,
            deadlineMs:
              typeof body.deadlineMs === "number" ? body.deadlineMs : undefined,
          }),
        );
      }
      // ---------------------------------------------------- MCP credentials
      //
      // CIPHERTEXT ONLY. The Python plane encrypts with AES-256-GCM before
      // anything reaches here, so every payload below carries an `envelope`
      // string plus non-secret metadata. No plaintext token, refresh token or
      // client secret can arrive through these ops, because none is ever sent.
      //
      // These live on the ingress path rather than as actions because
      // `TokenStorage.set_tokens` fires deep inside an SDK token refresh,
      // mid-tool-call, with no Convex action in the loop — the Python plane has
      // to be able to write on its own.
      case "mcp-credential-load": {
        const credential = await ctx.runQuery(
          internal.mcp.credentials.loadCredential,
          {
            connectionId: body.connectionId as Id<"mcpConnections">,
            resource: String(body.resource ?? ""),
            kind: (body.kind ?? "oauth_token") as
              | "oauth_token"
              | "api_key"
              | "bearer",
            // The tenant the plane acts for; the query holds it to the row.
            userId: body.userId as Id<"users">,
            workspaceId: body.workspaceId as Id<"workspaces">,
          },
        );
        return aiJson({ credential });
      }
      case "mcp-credential-save": {
        const saved = await ctx.runMutation(
          internal.mcp.credentials.saveCredential,
          {
            credentialId: String(body.credentialId ?? ""),
            userId: body.userId as Id<"users">,
            workspaceId: body.workspaceId as Id<"workspaces">,
            connectionId: body.connectionId as Id<"mcpConnections">,
            serverName: String(body.serverName ?? ""),
            resource: String(body.resource ?? ""),
            kind: (body.kind ?? "oauth_token") as
              | "oauth_token"
              | "api_key"
              | "bearer",
            envelope: String(body.envelope ?? ""),
            keyVersion: Number(body.keyVersion ?? 0),
            expiresAt:
              typeof body.expiresAt === "number" ? body.expiresAt : undefined,
            scope: typeof body.scope === "string" ? body.scope : undefined,
            status: (body.status ?? "active") as
              | "active"
              | "expired"
              | "refresh_failed"
              | "revoked"
              | "unreadable",
            rev: Number(body.rev ?? 0),
            expectedRev: Number(body.expectedRev ?? 0),
          },
        );
        return aiJson(saved);
      }
      case "mcp-credential-mark": {
        return aiJson(
          await ctx.runMutation(internal.mcp.credentials.markCredential, {
            credentialId: String(body.credentialId ?? ""),
            status: (body.status ?? "unreadable") as
              | "active"
              | "expired"
              | "refresh_failed"
              | "revoked"
              | "unreadable",
            userId: body.userId as Id<"users">,
            workspaceId: body.workspaceId as Id<"workspaces">,
            connectionId: body.connectionId as Id<"mcpConnections">,
          }),
        );
      }
      // `mcp-credential-delete` was REMOVED (audit H-17): the ingress secret
      // must not carry the authority to delete a credential. Rows are purged by
      // `mcp.oauth.disconnect` after the plane confirms the session is gone.
      case "mcp-quota-consume": {
        // The durable hourly tool-call window (audit H-09). Fail closed on a
        // malformed body: no user, no window, no call.
        if (typeof body.userId !== "string" || body.kind !== "mcpToolCall") {
          return aiJson({ ok: false, detail: "bad request" }, 400);
        }
        return aiJson(
          await ctx.runMutation(internal.mcp.limits.consumeForPlane, {
            userId: body.userId as Id<"users">,
            kind: "mcpToolCall",
          }),
        );
      }
      case "mcp-oauth-client-load": {
        const client = await ctx.runQuery(internal.mcp.credentials.loadClient, {
          serverName: String(body.serverName ?? ""),
          issuer: String(body.issuer ?? ""),
        });
        return aiJson({ client });
      }
      case "mcp-oauth-client-save": {
        await ctx.runMutation(internal.mcp.credentials.saveClient, {
          clientRecordId: String(body.clientRecordId ?? ""),
          serverName: String(body.serverName ?? ""),
          issuer: String(body.issuer ?? ""),
          envelope: String(body.envelope ?? ""),
          keyVersion: Number(body.keyVersion ?? 0),
          registrationMode: (body.registrationMode ?? "dcr") as
            | "dcr"
            | "cimd"
            | "preregistered",
        });
        return aiJson({ ok: true });
      }
      default:
        return aiJson({ error: `unknown op: ${body.op}` }, 400);
    }
  }),
});

// The OAuth redirect target.
//
// WHY IT LIVES HERE and not in the Next.js app: the app is locale-prefixed
// (`/[locale]/...` via next-international), and an OAuth redirect_uri must be an
// EXACT registered string. An app route would bake in "en" and break for every
// other locale. This path has no locale segment and is already publicly routed.
//
// WHY IT IS UNAUTHENTICATED. The browser arrives straight from the OAuth
// provider carrying no OllaSuper session — that is what a redirect is. The
// binding is `state`: the Python plane holds it in memory against the tenant who
// STARTED the flow, and the credential is written for THAT tenant, never for
// whoever delivered the callback. So a replayed or misdirected callback cannot
// bind an account to the wrong user, and the MCP SDK independently re-validates
// the state with a constant-time compare before exchanging anything.
http.route({
  path: "/mcp/oauth/callback",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const url = new URL(req.url);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const iss = url.searchParams.get("iss");

    const base = process.env.AI_BASE_URL;
    const key = process.env.AI_SERVICE_KEY;
    // SHAPE-CHECKED before anything is forwarded (audit M-01): `state` is a
    // 43-char URL-safe token the plane minted; `code` is what a provider
    // issues. Anything else is not a callback, and the plane is not asked.
    const shaped =
      /^[A-Za-z0-9_-]{16,128}$/.test(state) &&
      (code === null || (code.length > 0 && code.length <= 2048)) &&
      (iss === null || iss.length <= 512) &&
      (error === null || error.length <= 256);
    if (!base || !key || !state || !shaped) {
      return callbackPage(false, "This authorization link is not valid.");
    }

    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/v1/mcp/oauth/callback`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-service-key": key },
        body: JSON.stringify({ state, code, iss, error }),
        signal: AbortSignal.timeout(45_000),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        detail?: string;
      };
      if (res.ok && payload.ok) {
        return callbackPage(true, "You can close this window.");
      }
      // `detail` is already classified and bounded by the Python plane: an
      // RFC 6749 code plus a sentence, never the provider's raw body.
      return callbackPage(
        false,
        payload.detail ?? "Authorization did not complete.",
      );
    } catch {
      // Never echo the exception: it can carry an internal hostname.
      return callbackPage(false, "The service could not be reached.");
    }
  }),
});

/** Escape anything that reaches the callback page. */
function escapeMcpHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The page the user lands on. Deliberately plain.
 *
 * Carries NO token, NO code and NO state — the browser has already done its one
 * job. `Cache-Control: no-store` because the URL that produced it contained an
 * authorization code, and `Referrer-Policy: no-referrer` so that code cannot
 * ride out in a Referer header.
 */
function callbackPage(ok: boolean, message: string): Response {
  const title = ok ? "Connected" : "Authorization failed";
  const body = "font:16px system-ui;margin:4rem auto;max-width:32rem;text-align:center;color:#111";
  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeMcpHtml(title)}</title></head>
<body style="${body}">
<h1 style="font-size:1.25rem">${escapeMcpHtml(title)}</h1>
<p style="color:#555">${escapeMcpHtml(message)}</p>
</body></html>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

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

// File Generation System — STORE a generated file blob (Python → Convex).
//
// Dedicated binary endpoint (not the JSON ingress): the rendered bytes are the POST
// body; format/filename ride headers. Capability-scoped by streamId exactly like
// /ai/file — the owning user/thread/message is resolved server-side (registerArtifact)
// and never trusted from Python. A missing stream → the just-stored blob is discarded
// and a 404 returned (no orphan). storageId never crosses back to Python.
const MAX_ARTIFACT_BYTES = 30_000_000;
http.route({
  path: "/ai/artifact",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!authorizeIngress(req))
      return new Response("unauthorized", { status: 401 });
    const streamId = req.headers.get("x-stream-id") ?? "";
    const format = (req.headers.get("x-artifact-format") ?? "").slice(0, 12);
    const filename = (req.headers.get("x-artifact-filename") ?? "file").slice(0, 200);
    const mime = req.headers.get("content-type") ?? "application/octet-stream";
    if (!streamId || !format) return aiJson({ error: "bad request" }, 400);
    // Read the streaming request body ONCE. A streaming Blob (`req.blob()`) cannot be
    // re-read, so hashing it (below) and THEN `ctx.storage.store(blob)` throws "Can't
    // re-read streaming Blob" — the SAME trap fixed in /ai/seo-artifact. Filegen sends
    // no checksum so the old code only read once and worked, but the SEO report emitter
    // ALWAYS declares a SHA-256, so its artifact store 500'd and the report card never
    // rendered (report.emit_failed). Materialize the bytes and reuse them for both.
    const ab = await req.arrayBuffer();
    if (ab.byteLength === 0 || ab.byteLength > MAX_ARTIFACT_BYTES) {
      return aiJson({ error: "bad size" }, 400);
    }
    // Phase 3 (optional, additive): integrity verification. If the worker declared a
    // SHA-256, recompute it over the received bytes and REJECT a mismatch BEFORE
    // storing (a corrupted/tampered upload never becomes an artifact). Filegen sends
    // no header ⇒ this block is skipped ⇒ byte-identical.
    const declaredHash = req.headers.get("x-artifact-sha256");
    let contentHash: string | undefined;
    if (declaredHash) {
      const buf = await crypto.subtle.digest("SHA-256", ab);
      contentHash = Array.from(new Uint8Array(buf), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      if (contentHash !== declaredHash.toLowerCase()) {
        return aiJson({ error: "checksum mismatch" }, 422);
      }
    }
    const artifactKey = req.headers.get("x-artifact-key") ?? undefined;
    // Documents inline preview (additive): a child preview-page image declares its
    // parent artifact + role/page. Absent for filegen/SEO ⇒ byte-identical.
    const parentArtifactId = req.headers.get("x-artifact-parent") ?? undefined;
    const role = req.headers.get("x-artifact-role") ?? undefined;
    const pageHeader = req.headers.get("x-artifact-page");
    const page =
      pageHeader && /^\d{1,6}$/.test(pageHeader) ? Number(pageHeader) : undefined;
    // Store under a NON-EXECUTABLE type. The blob's own type is what a raw
    // ctx.storage.getUrl() serves, and that URL is same-origin with the app, so
    // a text/html artifact was stored XSS — which is not hypothetical: the
    // census found three html artifacts and one svg already stored this way,
    // because `mime` here is simply the worker's request content-type. The
    // declared mime still goes on the row below, and /artifact/file serves the
    // download from THAT, so nothing about the feature changes.
    const storageId = await ctx.storage.store(
      new Blob([ab], { type: neutralizedBlobType(mime) }),
    );
    const res = await ctx.runMutation(internal.chat.artifacts.registerArtifact, {
      streamId,
      storageId,
      filename,
      format,
      mime,
      size: ab.byteLength,
      ...(contentHash ? { contentHash } : {}),
      ...(artifactKey ? { artifactKey } : {}),
      ...(parentArtifactId ? { parentArtifactId } : {}),
      ...(role ? { role } : {}),
      ...(page !== undefined ? { page } : {}),
    });
    if (!res.ok || !res.artifactId) {
      await ctx.storage.delete(storageId).catch(() => {});
      return new Response("not found", { status: 404 });
    }
    return aiJson({ artifactId: res.artifactId, size: ab.byteLength });
  }),
});

// File Generation System — DOWNLOAD a generated file (browser → Convex).
//
// GET with a short-TTL one-time token minted by the AUTHENTICATED chat.artifacts
// .mintDownload (ownership already enforced there). Public route like /share/file:
// access is gated by the unguessable, expiring token + the resolve query; storageId
// never leaves the server, and Content-Disposition forces a download with the
// server-slugified filename.
http.route({
  path: "/artifact/file",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const token = new URL(req.url).searchParams.get("t");
    if (!token) return new Response("not found", { status: 404 });
    const allowed = await ctx.runQuery(
      internal.chat.artifacts.resolveDownload,
      { token },
    );
    if (!allowed) return new Response("not found", { status: 404 });
    const blob = await ctx.storage.get(allowed.storageId);
    if (!blob) return new Response("not found", { status: 404 });
    const safe = allowed.filename.replace(/["\\\r\n]/g, "_");
    return new Response(blob, {
      headers: {
        "content-type": allowed.mime,
        // Defence in depth beside the disposition above: this origin gets no
        // nosniff from next.config.mjs (those headers only cover :3000, never
        // /__cvx*), and `mime` is the artifact row's declared value.
        "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename="${safe}"`,
        "cache-control": "private, max-age=60",
      },
    });
  }),
});


// --- File Library: download / preview (browser → Convex) ---------------------
//
// A short-lived capability minted by library.mintAccess (owner-checked there)
// is RE-AUTHORISED on every request by library.resolveAccess: unexpired, the
// right purpose, the file still there and still its owner's, the owner still
// active and a member, and within the owner's hourly request/byte budget.
// Only the token's SHA-256 exists server-side. Every failure is one uniform
// 404 (429 for the budget), so nothing here is an existence oracle.
//
// Nothing a user uploaded is rendered as active content: a preview is served
// ONLY for a raster image identified from its bytes (never the name or stored
// type), under an allowlisted type; everything else — HTML, SVG, PDF,
// polyglots — is an attachment of type application/octet-stream.
// CORP is `same-site`, not `same-origin`: the preview <img> is served from the
// Convex SITE, which is the app's origin only in the path form (/__cvx-site).
// The host form (convex-site.ollasuper.com) and the VM's IP:port setup are
// cross-origin but same-site, and `same-origin` would silently blank every
// thumbnail there. Another SITE still cannot embed the bytes; the capability
// token is the gate either way.
const LIBRARY_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "sandbox; default-src 'none'",
  "cross-origin-resource-policy": "same-site",
} as const;

http.route({
  path: "/library/file",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const token = url.searchParams.get("t") ?? "";
    const purpose = url.searchParams.get("p") === "preview" ? "preview" : "download";
    const fail = (status: 404 | 429) =>
      new Response(status === 429 ? "too many requests" : "not found", {
        status,
        headers: LIBRARY_SECURITY_HEADERS,
      });
    // 32 random bytes, base64url: anything else is not one of ours.
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return fail(404);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    const r = await ctx.runMutation(internal.library.resolveAccess, { tokenHash, purpose });
    if (!r.ok) return fail(r.status === 429 ? 429 : 404);
    const blob = await ctx.storage.get(r.storageId);
    if (!blob) return fail(404);
    let contentType = "application/octet-stream";
    let disposition = contentDisposition("attachment", r.name);
    if (purpose === "preview") {
      const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      const image = inlineImageType(head);
      if (!image) return fail(404);
      contentType = image;
      disposition = contentDisposition("inline", r.name);
    }
    return new Response(blob, {
      headers: {
        ...LIBRARY_SECURITY_HEADERS,
        "content-type": contentType,
        "content-disposition": disposition,
        "content-length": String(blob.size),
      },
    });
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
    // NEVER echo the row's declared content-type back as a response header.
    //
    // chatAttachments.contentType is `args.contentType` from register() — chosen
    // by the client and never validated. blobSafety guards the BLOB's stored
    // type, which is what ctx.storage.getUrl() serves, so every OTHER surface is
    // covered by that; this route is the one that streams the bytes itself and
    // re-attaches the row's value on top, which put the guard back where it
    // started. The route is reachable at app.ollasuper.com/__cvx-site/share/file
    // — the APP'S OWN ORIGIN — and Convex adds no nosniff/CSP of its own, so a
    // declared `text/html` was same-origin script execution against any viewer.
    // share-attachment.tsx renders a non-image as a NAVIGATED link, so opening
    // the chip in a shared conversation was enough to trigger it.
    //
    // Allowlisted images keep their real type (the <img> path must still work);
    // everything else is downloaded, never rendered — the same posture
    // /artifact/file already takes.
    const inline = isInlineSafeImageType(allowed.contentType);
    const filename = (allowed.name || "file").replace(/["\\\r\n]/g, "_");
    return new Response(blob, {
      headers: {
        "content-type": inline ? allowed.contentType : "application/octet-stream",
        "x-content-type-options": "nosniff",
        ...(inline
          ? {}
          : { "content-disposition": `attachment; filename="${filename}"` }),
        "cache-control": "private, max-age=300",
      },
    });
  }),
});

// --- Mail provider delivery outcomes (Phase 4, Scheduled Tasks) -------------
/**
 * What actually happened after the provider accepted a report email.
 *
 * A 2xx on send only means custody changed hands; delivery, bounce and
 * complaint arrive later, or never. Without this route a delivery row stays
 * `accepted` forever, which is the honest state — so this endpoint upgrades
 * accuracy and is never load-bearing for correctness.
 *
 * PUBLIC and unauthenticated at the network level, so the signature IS the
 * authentication. Resend signs with Svix headers over `${id}.${timestamp}.${body}`
 * using a base64 secret prefixed `whsec_`. Verified here, before the body is
 * parsed as anything meaningful.
 */
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

async function verifySvix(
  secret: string,
  id: string,
  timestamp: string,
  signatureHeader: string,
  body: string,
): Promise<boolean> {
  // Replay window. Without it a captured request stays valid forever.
  const ts = Number(timestamp) * 1000;
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > WEBHOOK_TOLERANCE_MS) return false;

  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // The header carries space-separated `v1,<sig>` entries. Compare every one in
  // constant time — a length-independent early return would leak the prefix.
  let matched = false;
  for (const part of signatureHeader.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    if (sig.length !== expected.length) continue;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) {
      diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (diff === 0) matched = true;
  }
  return matched;
}

const PROVIDER_EVENTS: Record<string, "delivered" | "bounced" | "complained"> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

http.route({
  path: "/mail/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.SCHEDULED_EMAIL_WEBHOOK_SECRET;
    // Unconfigured means CLOSED, not open: an endpoint that accepts anything
    // when a secret is missing is worse than one that does not exist.
    if (!secret) return new Response("not configured", { status: 404 });

    const id = req.headers.get("svix-id") ?? "";
    const timestamp = req.headers.get("svix-timestamp") ?? "";
    const signature = req.headers.get("svix-signature") ?? "";
    if (!id || !timestamp || !signature) {
      return new Response("unsigned", { status: 401 });
    }
    // Read the RAW body: re-serialising JSON would change the bytes the
    // signature was computed over.
    const body = await req.text();
    if (!(await verifySvix(secret, id, timestamp, signature, body))) {
      return new Response("bad signature", { status: 401 });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const event = PROVIDER_EVENTS[String(payload.type ?? "")];
    const data = payload.data as { email_id?: unknown } | undefined;
    const messageId = typeof data?.email_id === "string" ? data.email_id : "";
    // An event we do not model, or one we cannot attribute, is acknowledged and
    // dropped — answering non-2xx would make the provider retry it forever.
    if (!event || !messageId) return new Response("ok", { status: 200 });

    await ctx.runMutation(internal.scheduled.delivery.applyProviderEvent, {
      providerMessageId: messageId,
      event,
    });
    return new Response("ok", { status: 200 });
  }),
});

export default http;
