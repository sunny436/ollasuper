import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

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
  }).index("email", ["email"]),

  events: defineTable({
    workspaceId: v.optional(v.id("workspaces")),
    source: v.string(),
    type: v.string(),
    payload: v.any(),
    receivedAt: v.number(),
  })
    .index("by_received", ["receivedAt"])
    .index("by_workspace", ["workspaceId"]),

  jobs: defineTable({
    workspaceId: v.optional(v.id("workspaces")),
    userId: v.id("users"),
    kind: v.string(),
    status: v.string(),
    input: v.optional(v.any()),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
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

  // Maintained counters so dashboard.stats is O(1) instead of scanning every row.
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
    folderId: v.optional(v.id("chatFolders")),
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
    .index("by_user_ws_folder_updated", [
      "userId",
      "workspaceId",
      "folderId",
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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_thread_seq", ["threadId", "seq"])
    .index("by_thread_parent", ["threadId", "parentId"])
    .index("by_client_id", ["clientId"])
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

  chatFolders: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    name: v.string(),
    color: v.optional(v.string()),
    order: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_ws_order", ["userId", "workspaceId", "order"]),

  // Prompts are the one chat entity where workspace sharing is sane: they are
  // authored artefacts, not private conversations. Opt-in, defaults to false.
  chatPrompts: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    title: v.string(),
    body: v.string(),
    description: v.optional(v.string()),
    tags: v.array(v.string()),
    shared: v.boolean(),
    usageCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_ws_updated", ["userId", "workspaceId", "updatedAt"])
    .index("by_ws_shared_updated", ["workspaceId", "shared", "updatedAt"]),

  chatSettings: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    defaultModel: v.string(),
    systemPrompt: v.optional(v.string()),
    customInstructionsAbout: v.optional(v.string()),
    customInstructionsStyle: v.optional(v.string()),
    sendOnEnter: v.boolean(),
    updatedAt: v.number(),
  }).index("by_user_workspace", ["userId", "workspaceId"]),

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
});
