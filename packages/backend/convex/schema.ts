import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { eventFields, eventObject } from "./chat/events";

// Multi-tenant: resources carry workspaceId. It is `optional` on pre-existing tables only so
// deploys don't fail validation against pre-migration rows; the function layer always sets it.
export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    username: v.optional(v.string()),
    imageId: v.optional(v.id("_storage")),
    // Account/security fields. ALL optional, and that is not laziness: the live
    // deployment holds rows created before these existed, and a required field
    // on an existing table fails schema validation on push (see CLAUDE.md).
    // Canonical address for comparison; see authPolicy.normalizeEmail.
    emailNormalized: v.optional(v.string()),
    // "active" | "suspended" | "deleted". Absent means active.
    accountStatus: v.optional(v.string()),
    lastLoginAt: v.optional(v.number()),
    // Refreshed by authed activity; the sliding-expiry signal is the refresh
    // token itself, so this is for display and anomaly review, not enforcement.
    lastActivityAt: v.optional(v.number()),
    passwordChangedAt: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("by_email_normalized", ["emailNormalized"]),

  // Account-level security history. Deliberately NOT auditLogs: those are
  // workspace-scoped product actions with a required workspaceId, whereas these
  // exist before any workspace does and must outlive workspace membership.
  // Purged after 90 days by crons.ts.
  authEvents: defineTable({
    userId: v.optional(v.id("users")),
    type: v.string(),
    at: v.number(),
    // Client-supplied, so NOT evidence — retained to correlate sessions only.
    userAgent: v.optional(v.string()),
    // Network prefix (/24, /48), never a full address. Usually absent: Convex
    // mutations get no request object, so only httpAction flows can supply one.
    ipPrefix: v.optional(v.string()),
    meta: v.optional(v.any()),
  })
    .index("by_user_at", ["userId", "at"])
    .index("by_at", ["at"]),

  // Per-normalized-email throttle for emailed one-time codes (verification /
  // reset / OTP). Bounds resend/verification/reset email-bombing. One row per
  // email, reused; no PII beyond the address that requested a code.
  authProbeLimits: defineTable({
    emailNormalized: v.string(),
    windowStart: v.number(),
    count: v.number(),
    lastSentAt: v.number(),
  }).index("by_email", ["emailNormalized"]),

  events: defineTable({
    workspaceId: v.optional(v.id("workspaces")),
    source: v.string(),
    type: v.string(),
    payload: v.any(),
    receivedAt: v.number(),
  })
    .index("by_received", ["receivedAt"])
    .index("by_workspace", ["workspaceId"]),

  auditLogs: defineTable({
    workspaceId: v.optional(v.id("workspaces")),
    userId: v.id("users"),
    action: v.string(),
    meta: v.optional(v.any()),
    at: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_workspace", ["workspaceId"]),

  usage: defineTable({
    workspaceId: v.optional(v.id("workspaces")),
    userId: v.optional(v.id("users")),
    metric: v.string(),
    count: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_metric", ["userId", "metric"])
    .index("by_workspace_metric", ["workspaceId", "metric"]),

  apiKeys: defineTable({
    workspaceId: v.optional(v.id("workspaces")),
    userId: v.id("users"),
    name: v.string(),
    prefix: v.string(),
    hash: v.string(),
    revoked: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_hash", ["hash"]),

  // Files (workspace-scoped). Stored in Convex file storage; row holds metadata.
  files: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    name: v.string(),
    storageId: v.id("_storage"),
    size: v.number(),
    contentType: v.string(),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  // Per-user file knowledge base (RAG). SEPARATE from `files` for the same
  // reason chatAttachments is: files.list returns every workspace row to any
  // member — right for a shared page, wrong for PRIVATE knowledge. This row is
  // the reactive METADATA MIRROR; the bytes/chunks/embeddings live in the
  // Python-owned pgvector DB. `ingestId` is a capability (like
  // chatStreams.streamId): the ingress file-fetch and the status callback are
  // scoped by it, so a leaked ingress secret cannot target a file by its id.
  userFiles: defineTable({
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    name: v.string(),
    // Convex STAGING blob. Deleted once Python confirms durable persistence;
    // the durable original is Postgres BYTEA, not this.
    storageId: v.optional(v.id("_storage")),
    size: v.number(),
    contentType: v.string(),
    ingestId: v.string(),
    status: v.union(
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    contentHash: v.optional(v.string()),
    chunkCount: v.optional(v.number()),
    pageCount: v.optional(v.number()),
    parserUsed: v.optional(v.string()),
    detectedType: v.optional(v.string()),
    error: v.optional(v.string()),
    // Truthful real-time ingestion progress (all optional -> additive, safe on
    // the live deployment). Written coarsely/throttled by Python's file-progress
    // callback while status === "processing"; cleared on a terminal status.
    // `note` is a partial-success message that survives onto a `ready` row
    // (e.g. a content-limit truncation).
    stage: v.optional(v.string()),
    progress: v.optional(v.number()),
    processedUnits: v.optional(v.number()),
    totalUnits: v.optional(v.number()),
    stageMessage: v.optional(v.string()),
    note: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_ws_created", ["userId", "workspaceId", "createdAt"])
    .index("by_ingestId", ["ingestId"])
    .index("by_status_updated", ["status", "updatedAt"])
    // Dedup an identical re-upload for the same user (never global — a global
    // content_hash would be a cross-user existence oracle).
    .index("by_user_hash", ["userId", "contentHash"])
    // Cheap "does this user have any ready files?" for the RAG retrieval gate.
    .index("by_user_status", ["userId", "status"])
    // Anti-claim-squat: a storageId registers exactly once (mirrors
    // chatAttachments.by_storage).
    .index("by_storage", ["storageId"]),

  workspaces: defineTable({
    name: v.string(),
    ownerId: v.id("users"),
    createdAt: v.number(),
  }),
  members: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    role: v.string(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_user_workspace", ["userId", "workspaceId"]),
  invites: defineTable({
    workspaceId: v.id("workspaces"),
    email: v.string(),
    role: v.string(),
    invitedBy: v.id("users"),
    accepted: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_email", ["email"]),

  notifications: defineTable({
    userId: v.id("users"),
    type: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    read: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_read", ["userId", "read"]),

  // Maintained per-workspace counters (members/files/chatThreads/chatMessages),
  // kept current via bump() so nothing has to scan a whole table to count.
  counters: defineTable({
    workspaceId: v.id("workspaces"),
    metric: v.string(),
    value: v.number(),
  }).index("by_workspace_metric", ["workspaceId", "metric"]),

  // ------------------------------------------------------------------ chat
  // Conversations are PRIVATE TO THE CREATING USER, workspace-scoped only for
  // tenancy/billing. This differs from every other table above, where the
  // workspace is the trust boundary — see convex/chat/authz.ts.
  //
  // Deliberately NO workspace-only index on chatThreads/chatMessages: with none,
  // no query shape in this codebase can enumerate a workspace's conversations
  // without pinning a userId first. Cascade deletes walk members.by_workspace.
  chatThreads: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    title: v.string(),
    // "auto" titles may be overwritten by the title generator; "user" never are.
    titleSource: v.union(v.literal("auto"), v.literal("user")),
    status: v.union(
      v.literal("active"),
      v.literal("archived"),
      v.literal("trashed"),
    ),
    pinned: v.boolean(),
    model: v.string(),
    systemPrompt: v.optional(v.string()),
    // Monotonic allocator for chatMessages.seq, bumped in the same transaction
    // as the insert, so Convex's OCC guarantees uniqueness without a scan.
    nextSeq: v.number(),
    messageCount: v.number(),
    tokensIn: v.number(),
    tokensOut: v.number(),
    // Non-null while a generation is in flight: lets the sidebar show a spinner
    // and lets send() reject a concurrent turn without a table scan.
    streamingMessageId: v.optional(v.id("chatMessages")),
    // Rolling summary lives here, NOT in a LangGraph checkpointer — Convex is
    // the single source of truth for conversation state.
    summary: v.optional(v.string()),
    summaryThroughSeq: v.optional(v.number()),
    lastMessageAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    trashedAt: v.optional(v.number()),
  })
    .index("by_user_ws_status_updated", [
      "userId",
      "workspaceId",
      "status",
      "updatedAt",
    ])
    .index("by_user_ws_pinned_updated", [
      "userId",
      "workspaceId",
      "pinned",
      "updatedAt",
    ])
    .index("by_trashed", ["status", "trashedAt"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["userId", "workspaceId", "status"],
    }),

  chatMessages: defineTable({
    threadId: v.id("chatThreads"),
    // Denormalised so the search index can filter on them and so authz never
    // needs a second db.get on a hot path. Always re-derived from the thread.
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
    ),
    // Per-thread monotonic integer, NOT _creationTime: regenerate/retry insert
    // rows whose logical position differs from wall-clock, and truncate needs an
    // indexed range delete (gte("seq", n)).
    seq: v.number(),
    // Written exactly TWICE in this row's life: "" on insert, final text on
    // finalize. Never patched during streaming — that is what keeps the message
    // list query stable (and the search index un-rewritten) mid-generation.
    content: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("streaming"),
      v.literal("complete"),
      v.literal("error"),
      v.literal("aborted"),
    ),
    // Idempotency for send(): the client mints this, we upsert on it.
    clientId: v.optional(v.string()),
    // Regenerate / branching, tail-only (flat sibling set, not a DAG).
    parentId: v.optional(v.id("chatMessages")),
    variantIndex: v.optional(v.number()),
    variantCount: v.optional(v.number()),
    activeVariantIndex: v.optional(v.number()),
    // Generation metadata.
    model: v.optional(v.string()),
    provider: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    finishReason: v.optional(v.string()),
    error: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    attachmentIds: v.optional(v.array(v.id("chatAttachments"))),
    tokensIn: v.optional(v.number()),
    tokensOut: v.optional(v.number()),
    costUsd: v.optional(v.number()),
    firstTokenMs: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    // Typed events (Phase 3). Written ONCE at finalize (the "second write"),
    // and only for generations that actually emitted structured events — a
    // pure text turn leaves this absent, so it renders exactly as before.
    events: v.optional(v.array(eventObject)),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_thread_seq", ["threadId", "seq"])
    .index("by_thread_parent", ["threadId", "parentId"])
    // userId first: a bare clientId index makes the idempotency probe global,
    // so a colliding id from another user would silently swallow the send and
    // hand back THEIR message id.
    .index("by_client_id", ["userId", "clientId"])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["userId", "workspaceId", "threadId"],
    }),

  // Stream CONTROL row. Separate from chatMessages on purpose: this row is
  // patched on every delta and every heartbeat, and chatMessages carries a
  // full-text search index — patching there would re-index per token.
  chatStreams: defineTable({
    // UUID minted by Convex in messages.send. This is a capability: the ingress
    // is scoped by it, so a leaked ingress secret still cannot target a thread.
    streamId: v.string(),
    messageId: v.id("chatMessages"),
    threadId: v.id("chatThreads"),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
      v.literal("aborted"),
    ),
    cancelRequested: v.boolean(),
    chunkSeq: v.number(),
    // Compacted prefix; chunks <= committedSeq are folded in here and deleted.
    committedText: v.string(),
    committedSeq: v.number(),
    heartbeatAt: v.number(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    // Set on the first typed event. Gates the extra events read in stream.active
    // and the finalize fold, so normal text chat pays nothing.
    hasEvents: v.optional(v.boolean()),
  })
    .index("by_streamId", ["streamId"])
    .index("by_message", ["messageId"])
    .index("by_status_heartbeat", ["status", "heartbeatAt"])
    .index("by_user_status", ["userId", "status"]),

  // Append-only token batches. Bounded: compaction keeps <= ~24 rows resident
  // per in-flight message, and all rows are deleted at finalize.
  chatStreamChunks: defineTable({
    messageId: v.id("chatMessages"),
    streamId: v.string(),
    seq: v.number(),
    text: v.string(),
  }).index("by_message_seq", ["messageId", "seq"]),

  // Append-only TYPED events (Phase 3). Low-volume structured events only
  // (tool/citation/approval/artifact); text stays on chatStreamChunks. Mirrors
  // that table: idempotent by the (messageId, seq) uniqueness probe, deleted
  // inline at finalize/fail/stop/cascade (never a cron). Folded into
  // chatMessages.events at finalize.
  chatStreamEvents: defineTable({
    messageId: v.id("chatMessages"),
    streamId: v.string(),
    ...eventFields,
  }).index("by_message_seq", ["messageId", "seq"]),



  chatSettings: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    defaultModel: v.string(),
    systemPrompt: v.optional(v.string()),
    customInstructionsAbout: v.optional(v.string()),
    customInstructionsStyle: v.optional(v.string()),
    sendOnEnter: v.boolean(),
    // Ambience theme intensity (0-100), synced across a user's devices. Optional
    // and additive so pre-migration rows validate on the live deployment.
    ambience: v.optional(v.number()),
    // Fixed-window generation counter. Lives here rather than in its own table
    // because this row is per-user-per-workspace, already indexed on exactly
    // that key, and already loaded on the dispatch path — so the rate check
    // costs one read that was happening anyway.
    rateWindowStart: v.optional(v.number()),
    rateWindowCount: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_user_workspace", ["userId", "workspaceId"]),

  // The OpenRouter catalogue, refreshed by chat/models.ts:refresh.
  //
  // This is a CACHE, not user data: it exists because assertAllowedModel runs
  // inside mutations, and Convex mutations cannot fetch. Validation therefore
  // has to read the allow-list from the database rather than from the network.
  //
  // One row per model rather than a single JSON blob, because the hot path is
  // an indexed point lookup by modelId on every send/regenerate/retry.
  chatModels: defineTable({
    modelId: v.string(),
    name: v.string(),
    contextLength: v.number(),
    // Kept as the raw per-token strings OpenRouter returns. The 5 meta-routers
    // (openrouter/auto, fusion, ...) report "-1" for variable pricing, so this
    // is deliberately not a number: the UI has to distinguish that from free.
    promptPrice: v.string(),
    completionPrice: v.string(),
    vision: v.boolean(),
    updatedAt: v.number(),
  }).index("by_model_id", ["modelId"]),

  // Separate from `files` ON PURPOSE: files.list returns every row in the
  // workspace to any member, which is right for a shared Files page and wrong
  // for chat uploads. These are private to the uploader and never listed there.
  chatAttachments: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    threadId: v.optional(v.id("chatThreads")),
    messageId: v.optional(v.id("chatMessages")),
    storageId: v.id("_storage"),
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    kind: v.union(v.literal("image"), v.literal("document"), v.literal("text")),
    extractedText: v.optional(v.string()),
    status: v.union(
      v.literal("uploaded"),
      v.literal("processing"),
      v.literal("ready"),
      v.literal("error"),
    ),
    createdAt: v.number(),
  })
    .index("by_user_ws_created", ["userId", "workspaceId", "createdAt"])
    .index("by_thread", ["threadId"])
    .index("by_message", ["messageId"])
    // Anti-claim-squat: a storageId may be registered exactly once, so user B
    // cannot claim a storageId belonging to user A. See chat/attachments.ts.
    .index("by_storage", ["storageId"]),

  // Public share links for a whole conversation or a single turn.
  //
  // SNAPSHOT-BASED: the shared content is frozen into `snapshot` at creation, so
  // later edits/deletes to the original never change an already-shared page, and
  // the public read never has to touch (or leak) live chat rows.
  //
  // The `token` is stored PLAINTEXT + indexed (unlike apiKeys, which store only a
  // hash) because the management "Copy link" and the public URL both need it
  // retrievable. A share token's blast radius is low — read-only, 7-day expiry,
  // revocable, no account access — so plaintext-at-rest is an acceptable trade.
  // Security rests on the 192-bit unguessable token + server-side expiry/revoke.
  chatShares: defineTable({
    token: v.string(),
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    chatId: v.id("chatThreads"),
    messageId: v.optional(v.id("chatMessages")), // single_turn only
    shareType: v.union(v.literal("full_chat"), v.literal("single_turn")),
    title: v.string(),
    // Frozen, sanitized JSON. storageIds live here (server-only) and are stripped
    // by the public read; the /share/file proxy resolves them. See chat/shares.ts.
    snapshot: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_user_ws_created", ["userId", "workspaceId", "createdAt"])
    .index("by_chat", ["chatId"]),
});
