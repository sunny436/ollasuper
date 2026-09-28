import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { eventFields, eventObject } from "./chat/events";
import {
  occurrenceKindValidator,
  occurrenceStatusValidator,
  scheduleSpecValidator,
  taskStatusValidator,
} from "./scheduled/schedule";

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
    .index("by_email_normalized", ["emailNormalized"])
    // Usernames had NO index and therefore no uniqueness: updateUsername did a
    // bare patch, so two accounts could hold one name — and getUser renders
    // `username || name` in the sidebar and greeting, making that impersonation.
    // Additive index only; Convex has no unique constraint, so the check lives
    // in the mutation, where the serializable transaction makes it race-safe.
    .index("by_username", ["username"])
    // Additive, and purely so the abandoned-signup purge can select exactly the
    // unverified rows. Without it the purge would scan the whole users table on
    // every pass to find a set that is normally tiny.
    .index("by_verification", ["emailVerificationTime"])
    // Blob provenance (audit F-01): "is this storage id already referenced by
    // any row?" must be answerable for every table that holds one.
    .index("by_image", ["imageId"]),

  // One row per issued upload URL, bound to the uploader (audit F-01). A blob
  // may be claimed only by a user holding an unconsumed intent whose window
  // contains the blob's creation — so a storage id learned from someone else's
  // URL (always older than the thief's intent, or already referenced) can never
  // be registered or deleted through another account.
  uploadIntents: defineTable({
    userId: v.id("users"),
    workspaceId: v.optional(v.id("workspaces")),
    createdAt: v.number(),
    expiresAt: v.number(),
    // Library upload SESSIONS (all optional — legacy intents carry none, and
    // behave exactly as before). `declaredBytes` is RESERVED against the user's
    // quota while the session is `created` and unexpired — computed live, so a
    // crashed browser's reservation simply lapses with the TTL.
    purpose: v.optional(v.union(v.literal("library"), v.literal("chat"))),
    declaredBytes: v.optional(v.number()),
    status: v.optional(
      v.union(v.literal("created"), v.literal("completed"), v.literal("aborted")),
    ),
  }).index("by_user_expires", ["userId", "expiresAt"]),

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

  // Confirmation codes for irreversible account deletion.
  //
  // DELIBERATELY NOT authVerificationCodes. A row in that table is redeemable by
  // `auth:signIn` for a real session (verifyCodeAndSignIn finds codes by hash
  // alone), so putting a deletion code there would mint a second, weaker way to
  // log in. This table is read by exactly one function and grants exactly one
  // capability.
  accountDeletionCodes: defineTable({
    userId: v.id("users"),
    // sha256, never the code itself — same rule the auth tables follow.
    codeHash: v.string(),
    expirationTime: v.number(),
    attempts: v.number(),
  }).index("by_user", ["userId"]),

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
  })
    .index("by_workspace", ["workspaceId"])
    // Blob provenance (audit F-01) — see users.by_image.
    .index("by_storage", ["storageId"]),

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
      // Kept, not processed: archives, unsupported types, generated files.
      // Terminal — no processing callback may move it.
      v.literal("stored"),
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
    // ---- File Library (all optional → additive; backfilled by
    // libraryMigrations). A row is ONE logical file: identical bytes uploaded
    // twice are two files. Its blob may also be referenced by chat attachments
    // (userFileId) and, for a generated file, by its chatArtifacts row — always
    // rows of the SAME owner.
    source: v.optional(v.union(v.literal("uploaded"), v.literal("generated"))),
    kind: v.optional(
      v.union(
        v.literal("image"),
        v.literal("pdf"),
        v.literal("document"),
        v.literal("spreadsheet"),
        v.literal("presentation"),
        v.literal("text"),
        v.literal("other"),
      ),
    ),
    // Lower-cased name: the name A–Z / Z–A sort key.
    nameKey: v.optional(v.string()),
    // Server-computed (Convex _storage.sha256), never the client's claim.
    sha256: v.optional(v.string()),
    artifactId: v.optional(v.id("chatArtifacts")),
    legacyFileId: v.optional(v.id("files")),
    // Manual-retry budget per file per day.
    retryDay: v.optional(v.number()),
    retriesToday: v.optional(v.number()),
  })
    .index("by_user_ws_created", ["userId", "workspaceId", "createdAt"])
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_user_ws_kind_created", ["userId", "workspaceId", "kind", "createdAt"])
    .index("by_user_ws_source_created", ["userId", "workspaceId", "source", "createdAt"])
    .index("by_user_ws_namekey", ["userId", "workspaceId", "nameKey"])
    .index("by_artifact", ["artifactId"])
    .index("by_legacy", ["legacyFileId"])
    // "You already have this file" — per OWNER only (a global hash lookup would
    // be a cross-user existence oracle). Never used to merge files.
    .index("by_user_sha256", ["userId", "sha256"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["userId", "workspaceId", "kind", "source"],
    })
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
    // Set when an account-deletion cascade starts tearing this workspace down
    // (audit F-12). A deleting workspace grants nothing: requireRole and invite
    // acceptance refuse it while its children drain. Optional => additive.
    deletingAt: v.optional(v.number()),
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
    // Phase 3 (Scheduled Tasks). All optional + additive, so every pre-existing
    // notification row still validates.
    //
    // `dedupeKey` is the LOGICAL event identity — for a scheduled run it is the
    // occurrenceKey, so a DBOS replay, a dispatch retry, a duplicate finalize
    // and the reaper all collapse to ONE notification. Enforced by a read of
    // by_user_dedupe inside the same mutation that writes the row: Convex
    // mutations are serialisable, so that read joins the transaction's read set
    // and a concurrent insert forces a retry rather than a duplicate.
    dedupeKey: v.optional(v.string()),
    // Deep link target. Kept as ids rather than a URL string so the UI owns
    // routing; both survive the task being soft-deleted (the link then resolves
    // to the "deleted" state rather than erroring).
    taskId: v.optional(v.id("scheduledTasks")),
    occurrenceKey: v.optional(v.string()),
    // The occurrence ITSELF, not just its key. `?run=` in the task detail takes
    // the occurrence _id, so without this a scheduled notification can only
    // reach the task, never the run it is actually about. Occurrences are never
    // deleted, so this link can never dangle.
    occurrenceId: v.optional(v.id("scheduledTaskOccurrences")),
    // Deep link for chat-side events (a failed turn, an approval). Threads CAN
    // be hard-deleted by chat.threads.purgeTrashed, so the UI must treat a
    // missing thread as a dead link and degrade, exactly as it does for a
    // deleted task.
    threadId: v.optional(v.id("chatThreads")),
  })
    .index("by_user", ["userId"])
    .index("by_user_read", ["userId", "read"])
    .index("by_user_dedupe", ["userId", "dedupeKey"]),

  // Maintained per-workspace counters (members/files/chatThreads/chatMessages),
  // kept current via bump() so nothing has to scan a whole table to count.
  counters: defineTable({
    workspaceId: v.id("workspaces"),
    metric: v.string(),
    value: v.number(),
  }).index("by_workspace_metric", ["workspaceId", "metric"]),

  // ------------------------------------- conversational context (platform)
  //
  // Continuity used to be solved per skill: runner.py seeds Deep Research from
  // `activeResearchRun`, Data Analysis from `datasets`, and neither helps Blog,
  // SEO, Coding or anything added later. These two tables are the
  // generalisation of that proven pattern, consumed through ONE seam
  // (build_system_prompt) so every skill inherits it and none reimplements it.

  /**
   * One row per thread: what this conversation is currently about.
   *
   * OWNERSHIP IS SPLIT AND ENFORCED AT MERGE. The FLOOR fields are recomputed
   * in code on every turn from data the application already has, and a model
   * can never overwrite them. Only the enrichment fields come from the
   * `record_context` tool. So a model that never calls that tool leaves nothing
   * critical missing or stale — it only leaves constraints and decisions
   * un-enriched — and nothing in the resolution path reads a model-owned field.
   */
  conversationState: defineTable({
    threadId: v.id("chatThreads"),
    userId: v.id("users"),

    // ---- FLOOR-OWNED (derived in code every turn) ----
    /** Stable id of the artifact a bare reference resolves to. */
    activeArtifactId: v.optional(v.string()),
    activeArtifactVersion: v.optional(v.number()),
    activeSubject: v.optional(v.string()),
    /**
     * Entities with their ACTIVATION order, not merely their mention order.
     * "Go back to PostgreSQL" re-activates PostgreSQL, so a following "compare
     * that with Redis" binds `that` to PostgreSQL rather than to the lexically
     * nearest mention. Recency of mention alone gets this wrong.
     */
    entities: v.optional(
      v.array(v.object({ name: v.string(), activatedAtSeq: v.number() })),
    ),
    /** CREATE · MODIFY · EXTEND · REWRITE · CONTINUE · TRANSFORM · … */
    lastOperation: v.optional(v.string()),
    /** Highest message seq this state reflects. Makes the write idempotent. */
    updatedThroughSeq: v.number(),

    // ---- MODEL-ENRICHABLE (record_context; never required) ----
    /**
     * Requirements that still apply and must survive a narrow edit: asking to
     * "make it more human" must not discard technical accuracy or SEO intent.
     */
    userConstraints: v.optional(v.array(v.string())),
    userDecisions: v.optional(v.array(v.string())),
    openLoops: v.optional(v.array(v.string())),

    updatedAt: v.number(),
  }).index("by_thread", ["threadId"]),

  /**
   * Generated work as an addressable, versioned object.
   *
   * INDEXES INTO chatMessages — it never copies content. Messages are already
   * append-only (regenerate inserts a new row rather than editing one), so every
   * version is immutable for free, `searchIndex("search_content")` already
   * exists for retrieval, and there is exactly one source of truth for the text.
   *
   * Distinct from `chatArtifacts`, which is file-oriented (storageId, filename,
   * mime) and describes a downloadable produced by filegen. This describes a
   * conversational object, which is usually just prose in a message.
   */
  conversationArtifacts: defineTable({
    threadId: v.id("chatThreads"),
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    /** Stable across versions — this is what a reference resolves TO. */
    artifactId: v.string(),
    version: v.number(),
    /** blog · report · article · code · document · analysis · audit · … */
    kind: v.string(),
    subject: v.string(),
    /** "active" | "superseded" — the lineage head is the active one. */
    status: v.string(),
    /** WHERE THE CONTENT LIVES. Never a copy. */
    messageId: v.id("chatMessages"),
    /** The version this one replaced, so REVERT walks a chain, not a guess. */
    supersedesId: v.optional(v.id("conversationArtifacts")),
    /** The message seq, so ordering needs no join. */
    seq: v.number(),
    createdAt: v.number(),
  })
    .index("by_thread_seq", ["threadId", "seq"])
    .index("by_thread_artifact", ["threadId", "artifactId", "version"]),

  // -------------------------------------------------------------- projects
  // A Project is a first-class container for chats (Phase 1) and, later, files,
  // instructions and memory scope. It is PRIVATE TO THE CREATING USER inside a
  // workspace, exactly like chatThreads below — the workspace stays the
  // tenancy/billing boundary and is never the trust boundary for a Project.
  //
  // The index leads with userId for the same reason every chatThreads index
  // does: with no workspace-only index, no query shape here can enumerate a
  // tenant's Projects without pinning a userId first.
  projects: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    name: v.string(),
    // Stored and editable from Phase 1, but NOT injected into any prompt until
    // Phase 5. Deliberately not surfaced in the Phase 1 UI: a control that
    // silently does nothing is worse than an absent one.
    instructions: v.optional(v.string()),
    // active <-> archived -> trashed -> purged. Widening a union is additive:
    // every pre-Phase-6 row is still valid.
    status: v.union(
      v.literal("active"),
      v.literal("archived"),
      v.literal("trashed"),
    ),
    // Set on trash, cleared on restore. The 30-day purge cron reads it.
    //
    // Unlike chatThreads, trashing a Project does NOT schedule an immediate
    // purge: threads.remove does runAfter(0, purge), which makes their trash a
    // formality and their restore a race. A Project genuinely waits out the TTL,
    // so Delete is recoverable rather than merely labelled that way.
    trashedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_ws_status_updated", [
    "userId",
    "workspaceId",
    "status",
    "updatedAt",
  ]),

  // A file belongs to a Project through this JOIN, never through a column on
  // userFiles. That is forced by dedup: userFiles.saveFile returns the EXISTING
  // row for identical content (uq per user+contentHash), so one physical file
  // can legitimately be a member of several Projects at once. A projectId column
  // could only ever record the first one.
  //
  // Unlinking removes an edge here and NOTHING else — the file, its Postgres
  // blob and its chunks survive, because another Project (or the account-wide
  // corpus) may still reference them.
  projectFiles: defineTable({
    projectId: v.id("projects"),
    fileId: v.id("userFiles"),
    // Denormalised owner. Both sides are already owner-checked on write; this
    // exists so the file-delete cascade can find edges without loading projects.
    userId: v.id("users"),
    addedAt: v.number(),
  })
    // The Project sources list, and the retrieval scope.
    .index("by_project", ["projectId"])
    // Cascade: userFiles.remove drops every edge pointing at the deleted file.
    .index("by_file", ["fileId"])
    // Idempotent linking — adding the same file twice must not create a second
    // edge, and must not re-trigger ingestion.
    .index("by_project_file", ["projectId", "fileId"]),

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
      // Scheduled Tasks (Phase 2). A dedicated execution thread for ONE
      // scheduled task. It is a distinct STATUS rather than a flag because
      // every list/search path already filters on status with an equality
      // index — `threads.list`, `listPinned` and both `search_title` sites all
      // pin "active" — so this value excludes the thread from the whole chat
      // surface with ZERO changes to threads.ts / search.ts.
      v.literal("scheduled"),
    ),
    // Set only on a `scheduled` thread: the task it executes. dispatchPayload
    // branches on this to send NO history and NO summary, which is what stops a
    // daily task accumulating a year of its own previous runs as context.
    scheduledTaskId: v.optional(v.id("scheduledTasks")),
    // The Project this conversation belongs to, or absent for an ordinary
    // chat. OPTIONAL and never backfilled: every pre-Projects thread reads back
    // as undefined and behaves exactly as it did before. Set ONLY by
    // threads.create after requireProjectAccess — never patched from a client.
    projectId: v.optional(v.id("projects")),
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
    // UNTRUSTED connectors the user has opted into for this thread, by slug
    // (mcp/activation.ts; audit H-06). Absent = none. Additive: pre-existing
    // threads simply have no untrusted connector composed until named.
    mcpActivated: v.optional(v.array(v.string())),
    // Composer follow-up chips for the most recent completed turn. Deliberately
    // NOT a chatMessages row: they are transient composer UI, so they must stay
    // out of the transcript, the search index and the model's context.
    // `suggestionsForSeq` is the assistant seq they belong to — the monotonic
    // guard that stops a slow call from an older turn overwriting a newer one.
    suggestions: v.optional(v.array(v.string())),
    suggestionsForSeq: v.optional(v.number()),
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
    // Backs the per-Project chat list. `status` is part of the key so the
    // list can separate active from archived chats, and so a hidden
    // status="scheduled" thread can never surface as a conversation once
    // Phase 6 starts attaching Projects to scheduled tasks.
    .index("by_user_ws_project_status_updated", [
      "userId",
      "workspaceId",
      "projectId",
      "status",
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
    // Which model ACTUALLY produced this turn once the Master Model Router
    // has run, plus the structured reason it was chosen. Additive and
    // optional: every pre-router row reads back undefined and renders the
    // same. Internal observability only — never projected to the client.
    routedReason: v.optional(v.string()),
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
    // Phase 4: set by `stop` when the turn was cancelled while a SIDE-EFFECTING
    // tool was still RUNNING (a durable RUNNING execution row existed at the
    // stop). The external effect may have completed after we finalized, so the
    // message carries an honest marker rather than claiming a clean cancel.
    interruptedSideEffect: v.optional(v.object({ toolId: v.string() })),
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
      // Phase 8: parked awaiting a user approval decision. Additive literal —
      // existing rows still validate. Invisible to the stall reaper (which scans
      // running/queued only), so a parked turn is never resumed as "stalled".
      v.literal("waiting_approval"),
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
    // Phase 7 durable execution. `attempts` bounds reaper-driven resumes of a
    // crashed turn (mirrors userFiles.attempts); `deadlineAt` (epoch ms) is the
    // total-execution deadline enforced by both Python and the reaper. Both
    // optional + additive so pre-migration rows validate on the live deployment.
    attempts: v.optional(v.number()),
    deadlineAt: v.optional(v.number()),
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

  // Phase 8: durable tool-approval records. A HIGH_IMPACT tool that needs
  // user approval parks a row here + flips its stream to "waiting_approval";
  // the user resolves it, or the expiry reaper marks it "expired". The approval
  // TOKEN (minted server-side on approve) is the only execute capability — the
  // model never sees it. `approvalId` is STABLE = tool_id + hash(canonical args)
  // (resume-stable, unlike the model's per-turn tool_call id), so a re-emitted
  // request on resume upserts the SAME row rather than creating a duplicate.
  chatApprovals: defineTable({
    approvalId: v.string(),
    streamId: v.string(),
    messageId: v.id("chatMessages"),
    threadId: v.id("chatThreads"),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    toolId: v.string(),
    toolName: v.string(),
    argsKey: v.string(),
    reason: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("rejected"),
      v.literal("expired"),
      v.literal("cancelled"),
    ),
    token: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.id("users")),
  })
    .index("by_stream_approval", ["streamId", "approvalId"])
    .index("by_status_expiresAt", ["status", "expiresAt"])
    .index("by_thread_status", ["threadId", "status"]),

  // Phase 3 — durable per-execution record; the crash-recovery AUTHORITY for one
  // tool run. A superset of the in-memory ToolExecution (services/ai app/models/
  // execution.py): written write-ahead (RUNNING before a side effect), advanced
  // along the same state machine, read on resume by dispatchPayload, and DELETED
  // at finalize (mirrors chatStreamEvents). Ownership ids are DERIVED from the
  // stream, never client-sent. Idempotent by (streamId, executionId) — executionId
  // is the app uuid4 (resume-stable), never the model's per-turn tool_call id. A
  // brand-new table with no pre-migration rows may carry required fields.
  toolExecutions: defineTable({
    executionId: v.string(),
    streamId: v.string(),
    messageId: v.id("chatMessages"),
    threadId: v.id("chatThreads"),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    stepId: v.string(),
    toolCallId: v.string(),
    toolId: v.string(),
    attemptId: v.string(),
    attempt: v.number(),
    actionType: v.string(),
    sideEffect: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("waiting_approval"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("timed_out"),
      v.literal("indeterminate"),
      v.literal("deduped"),
    ),
    inputHash: v.string(),
    // The DURABLE args (enables direct approval continuation without model re-emit).
    args: v.optional(v.any()),
    resultContent: v.optional(v.string()),
    resultReference: v.optional(v.string()), // reserved (large-result pointer)
    error: v.optional(v.string()),
    approvalRef: v.optional(v.string()),
    parentStep: v.optional(v.string()), // reserved (step graph)
    dependencies: v.optional(v.array(v.string())), // reserved (DAG)
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_stream_execution", ["streamId", "executionId"])
    .index("by_message", ["messageId"])
    .index("by_state_updated", ["state", "updatedAt"]),

  // File Generation System — a PERSISTENT downloadable file the assistant generated
  // (PDF/DOCX/XLSX/…). Owner ids are DERIVED from the stream (never client-sent), like
  // toolExecutions — but UNLIKE the ledger this is NOT deleted at finalize: the download
  // must keep working after the turn. The Convex `_id` is the artifact identifier
  // carried in the ARTIFACT event. `downloadToken`/`…ExpiresAt` hold a single short-TTL
  // token overwritten per authenticated mint — ownership is enforced by `mintDownload`
  // (getAuthUserId), the token is only browser-reachability. Additive table (no
  // pre-migration rows), so required fields are safe.
  chatArtifacts: defineTable({
    streamId: v.string(),
    messageId: v.id("chatMessages"),
    threadId: v.id("chatThreads"),
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    storageId: v.id("_storage"),
    filename: v.string(),
    format: v.string(),
    mime: v.string(),
    size: v.number(),
    createdAt: v.number(),
    downloadToken: v.optional(v.string()),
    downloadTokenExpiresAt: v.optional(v.number()),
    // Phase 3 (additive, optional): `contentHash` = the SHA-256 verified at upload
    // (integrity); `artifactKey` = a stable per-(stream) idempotency key so a
    // crash-resume re-store returns the existing row instead of a duplicate blob.
    // Filegen sets neither ⇒ existing rows/behavior are unchanged.
    contentHash: v.optional(v.string()),
    artifactKey: v.optional(v.string()),
    // Documents inline preview (additive, optional): a preview page image is a CHILD
    // artifact of the pptx/pdf it previews — `parentArtifactId` links it, `role`
    // ("preview") marks it so it is NOT rendered as its own download card, and `page`
    // orders the strip. The parent (and filegen/SEO) set none ⇒ existing rows unchanged.
    parentArtifactId: v.optional(v.id("chatArtifacts")),
    role: v.optional(v.string()),
    page: v.optional(v.number()),
  })
    .index("by_downloadToken", ["downloadToken"])
    .index("by_message", ["messageId"])
    .index("by_thread", ["threadId"])
    .index("by_stream_key", ["streamId", "artifactKey"])
    .index("by_parent", ["parentArtifactId"])
    // Blob provenance (audit F-01) — see users.by_image.
    .index("by_storage", ["storageId"]),

  // Phase 7 — the durable, owner-scoped SEO MUTATION ledger: the auditable RESULT
  // record for one approved site change (update metadata / structured data / redirect /
  // content). Recorded at EXECUTE time only; the PROPOSAL lives in the APPROVAL_REQUEST
  // event + auditLogs. A dedicated table (not toolExecutions, which is DELETED at finalize;
  // not auditLogs, which is WORKSPACE-trust and would leak one user's before/after to
  // co-members) because mutation history is USER-trust owner-scoped like chat. Owner ids
  // are DERIVED from the stream, never client-sent. before/after/verification/estimatedCost
  // are bounded JSON strings (the seoReports.report / chatShares.snapshot pattern — no v.any(),
  // no payload-shape push). Idempotent by `approvalId` (a write is authorized by exactly one
  // single-use approval). Additive table (no pre-migration rows), so required fields are safe.
  seoMutations: defineTable({
    approvalId: v.string(), // the ONLY execute capability — the approval that authorized this write
    executionId: v.optional(v.string()), // the toolExecutions row (idempotency cross-ref)
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    streamId: v.optional(v.string()),
    threadId: v.optional(v.id("chatThreads")),
    messageId: v.optional(v.id("chatMessages")),
    runId: v.optional(v.string()),
    toolId: v.string(),
    action: v.union(
      v.literal("update_metadata"),
      v.literal("update_structured_data"),
      v.literal("propose_redirect"),
      v.literal("update_content"),
    ),
    target: v.string(),
    provider: v.string(),
    argsHash: v.string(),
    reversibility: v.union(v.literal("reversible"), v.literal("irreversible")),
    estimatedCost: v.optional(v.string()), // bounded JSON
    status: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("verification_failed"),
      v.literal("precondition_failed"),
      v.literal("rolled_back"),
      v.literal("rollback_failed"),
    ),
    before: v.optional(v.string()), // bounded JSON snapshot
    after: v.optional(v.string()), // bounded JSON snapshot
    verification: v.optional(v.string()), // bounded JSON {method,passed,detail}
    rollbackStatus: v.union(
      v.literal("none"),
      v.literal("not_needed"),
      v.literal("succeeded"),
      v.literal("failed"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_thread", ["threadId"])
    .index("by_approval", ["approvalId"])
    .index("by_execution", ["executionId"]),

  // Deep Research — the durable, owner-scoped, RESUMABLE research state for one run.
  // `checkpoint` (researchRuns.ts) is the ONLY writer, called from http.ts
  // (op:"research-checkpoint", ingress-secret-verified) when the agent's reserved
  // `record_research` tool fires. Owner/workspace/thread ids are DERIVED from the
  // stream (never client-sent), exactly like seoMutations/chat executions. Idempotent
  // by `researchRunId` (upsert in place — a resume never duplicates a row). USER-trust
  // owner-scoped (a non-owner gets nothing, never an oracle). plan/evidence are bounded
  // JSON strings (the seoReports/chatShares pattern — no v.any(), no payload-shape push).
  // FUTURE-SAFE: many rows per thread are allowed (NO unique-thread constraint); the
  // "one active run" policy is a QUERY choice (newest incomplete by_thread), so a
  // future multi-run model needs no migration. Additive table (no pre-migration rows),
  // so required fields are safe.
  researchRuns: defineTable({
    researchRunId: v.string(), // stable idempotency key (Python-minted per run)
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    threadId: v.id("chatThreads"),
    streamId: v.optional(v.string()),
    messageId: v.optional(v.id("chatMessages")),
    objective: v.string(),
    reason: v.optional(v.string()), // H1: a short SAFE label, never chain-of-thought
    status: v.union(
      v.literal("planning"),
      v.literal("researching"),
      v.literal("synthesizing"),
      v.literal("complete"),
      v.literal("stopped"),
      v.literal("failed"),
    ),
    timeSensitive: v.boolean(),
    plan: v.optional(v.string()), // bounded JSON: sub-questions[]
    evidence: v.optional(v.string()), // bounded JSON: findings[] with provenance
    sourceCount: v.number(), // distinct sources read (the H4 budget counter)
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_run", ["researchRunId"])
    .index("by_thread", ["threadId"])
    .index("by_user", ["userId"]),

  // ---- File Library ------------------------------------------------------
  // Quota ledger. key = "user:<userId>" (uploaded bytes, app-wide, the user's
  // 100 MB) or "global" (every Library byte — the capacity safety net).
  // Written ONLY inside the mutations that create or delete Library files, so
  // it is transactional with them; libraryMigrations.recomputeUsage re-derives
  // it from the rows. `nearFullAt` drives the one-time 90 % notice.
  storageUsage: defineTable({
    key: v.string(),
    usedBytes: v.number(),
    files: v.number(),
    nearFullAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  // Short-lived download/preview capabilities. Only the SHA-256 of the token is
  // stored; every use re-checks the file, its owner and the purpose.
  fileAccessTokens: defineTable({
    tokenHash: v.string(),
    fileId: v.id("userFiles"),
    userId: v.id("users"),
    purpose: v.union(v.literal("download"), v.literal("preview")),
    expiresAt: v.number(),
  })
    .index("by_hash", ["tokenHash"])
    .index("by_file", ["fileId"])
    .index("by_expires", ["expiresAt"]),

  // Progress + verification ledger for libraryMigrations (resumable, dry-run
  // first). A destructive phase refuses to run until `verifiedAt` is set.
  migrationRuns: defineTable({
    name: v.string(),
    cursor: v.optional(v.string()),
    processed: v.number(),
    ok: v.number(),
    failed: v.number(),
    lastError: v.optional(v.string()),
    done: v.boolean(),
    verifiedAt: v.optional(v.number()),
    startedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_name", ["name"]),

  // Server-owned per-USER rate windows. Deliberately NOT on chatSettings: that
  // row is per-workspace and is deleted by chat.settings.reset, so a user could
  // multiply or simply erase their own allowance. See convex/quotas.ts.
  userQuotas: defineTable({
    userId: v.id("users"),
    kind: v.string(),
    windowStart: v.number(),
    windowCount: v.number(),
  }).index("by_user_kind", ["userId", "kind"]),

  chatSettings: defineTable({
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    defaultModel: v.string(),
    systemPrompt: v.optional(v.string()),
    customInstructionsAbout: v.optional(v.string()),
    // LEGACY prose style string. Kept written, and kept being sent, purely so a
    // rollback to a Python build that predates `personalization` still styles
    // replies. The canonical object below is the source of truth.
    customInstructionsStyle: v.optional(v.string()),
    // CANONICAL personalization. Structured because the prose string above was
    // round-tripped by exact substring match on the client, so rewording one
    // sentence silently switched a widget off for every stored user.
    //
    // Optional + additive: pre-migration rows validate untouched on the live
    // deployment, and an absent object simply means "product defaults".
    personalization: v.optional(
      v.object({
        // Bumped only if a future shape cannot be read by the current reader.
        version: v.number(),
        // Ignored, never deleted: disabling keeps the stored preferences so
        // re-enabling restores exactly what the user had.
        enabled: v.boolean(),
        baseStyle: v.union(
          v.literal("default"),
          v.literal("friendly"),
          v.literal("concise"),
          v.literal("formal"),
          v.literal("playful"),
        ),
        characteristics: v.array(
          v.union(
            v.literal("warm"),
            v.literal("enthusiastic"),
            v.literal("headers"),
            v.literal("emoji"),
          ),
        ),
        responseSpeed: v.union(
          v.literal("fast"),
          v.literal("balanced"),
          v.literal("thorough"),
        ),
        // "auto" = follow the user's own language. A label, never free text.
        responseLanguage: v.optional(v.string()),
      }),
    ),
    sendOnEnter: v.boolean(),
    // Ambience theme intensity (0-100), synced across a user's devices. Optional
    // and additive so pre-migration rows validate on the live deployment.
    ambience: v.optional(v.number()),
    // Accent colour, stored as the NAME of a palette entry ("blue", "green", …),
    // never as a colour value. Additive and optional like its neighbours, so
    // pre-existing rows validate untouched; absent means "product default".
    // The string is re-validated in chat/settings.ts on write — a client is not
    // trusted to have sent one of the seven.
    accentColor: v.optional(v.union(v.string(), v.null())),
    // Fixed-window generation counter. Lives here rather than in its own table
    // because this row is per-user-per-workspace, already indexed on exactly
    // that key, and already loaded on the dispatch path — so the rate check
    // costs one read that was happening anyway.
    rateWindowStart: v.optional(v.number()),
    rateWindowCount: v.optional(v.number()),
    // Phase 5: a SEPARATE fixed-window counter for durable SEO runs (a run is far
    // costlier than a chat turn, so it gets its own hourly cap). Same row/index as
    // the chat rate window; optional + additive so pre-migration rows validate.
    seoRunWindowStart: v.optional(v.number()),
    seoRunWindowCount: v.optional(v.number()),
    // Phase 3: a THIRD fixed-window counter, for the scheduling composer's
    // parse calls. Same row, same index, same shape as the two above — a parse
    // is a small model call, so it gets its own cheap budget rather than
    // spending the chat allowance.
    parseWindowStart: v.optional(v.number()),
    parseWindowCount: v.optional(v.number()),
    // Phase 4: a FOURTH fixed-window counter, for scheduled EXECUTION. Same row,
    // same index, same shape as the three above. Scheduled runs bypass
    // assertCanGenerate entirely (execution.ts calls startAssistantTurn direct),
    // so before this they consumed no budget at all. Deliberately separate from
    // rateWindow*: unattended work must never spend a user's interactive
    // allowance, and exhausting one must never block the other.
    schedRunWindowStart: v.optional(v.number()),
    schedRunWindowCount: v.optional(v.number()),
    // Phase 6: long-term memory master switch (per-user-per-workspace). Optional
    // + additive so pre-migration rows validate; absent is treated as ENABLED at
    // read time (dispatchPayload). A user can turn memory off entirely here.
    memoryEnabled: v.optional(v.boolean()),
    updatedAt: v.number(),
  }).index("by_user_workspace", ["userId", "workspaceId"]),

  // Phase 6 — long-term agent memory. Private-per-user (chat trust model), a
  // small flat set the agent RECALLS via search_memory and WRITES via remember
  // (validated server-side). NO vector index here — retrieval is a plain-index
  // pre-load + in-Python ranking. Every index is pinned to userId first, so no
  // query can enumerate a tenant's memories without an owner.
  /**
   * USER-AUTHORED CUSTOM SKILLS — private declarative guidance.
   *
   * A skill is TEXT the user wrote. It is not code, not a tool, and it carries
   * no credentials; nothing here is executable and nothing here is trusted
   * system configuration. The runtime phase must render it in its own UNTRUSTED
   * frame, never inside the built-in `<skill_guidance>` block, whose header
   * asserts the content is "authored by the system, not by any user".
   *
   * OWNERSHIP IS THE USER, NOT THE WORKSPACE. Every index pins `userId` first,
   * so no query shape here can enumerate a tenant's skills — the same property
   * `userMemories` relies on.
   */
  userSkills: defineTable({
    // The owner. Always the authenticated caller; never a client argument.
    userId: v.id("users"),
    // CREATION CONTEXT ONLY — deliberately NOT a scoping field.
    //
    // Skills are user-scoped: they follow the person across workspaces, exactly
    // as `userMemories` with scope "user" already do, and `memories.list`
    // already reads that way ("the user's OWN memories across workspaces").
    // This column exists because `audit()` requires a workspace and because
    // writes check `requireMember` — it records WHERE the skill was authored.
    // No read filters on it. If workspace-scoped skills are ever wanted, add a
    // `scope` union then; widening one is additive, and inventing a
    // single-valued union now would only look like a boundary that is not one.
    workspaceId: v.id("workspaces"),
    name: v.string(),
    description: v.string(),
    // The guidance itself. Prose only — validated on write, bounded, and
    // secret-scanned, because this text ends up in a model prompt.
    instructions: v.string(),
    constraints: v.optional(v.string()),
    /**
     * Capability REFERENCES the author declared — opaque hint strings, never
     * grants.
     *
     * These name existing capability intents (`metadata.audit`,
     * `research.web_search`) that live in the PYTHON plane, are flag-gated
     * there, and are resolved by `CapabilityResolver`. Convex cannot check them
     * on write: the catalogue is reachable only through an action, and a
     * mutation cannot call one. So validation is split where each half can
     * actually work — STRUCTURE here (count, length, charset), MEANING at
     * runtime, where `by_ids` skips unknown ids, `by_intents` reports gaps, and
     * authorization is enforced per call regardless. A stale or misspelled
     * entry is therefore inert, not dangerous.
     *
     * Nothing reads this yet: the live runner consumes only `require_approval`.
     * It is stored now so the write path is validated from the start rather
     * than retrofitted onto rows that were never checked.
     */
    capabilities: v.optional(v.array(v.string())),
    // Off means "do not consider this skill", never "delete it". Deletion is a
    // separate, explicit act.
    enabled: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    // Management list: the owner's skills, newest first.
    .index("by_user_updated", ["userId", "updatedAt"])
    // Runtime discovery (a later phase): only this user's ENABLED skills. The
    // enabled flag is in the INDEX rather than a post-filter so a disabled skill
    // cannot reach discovery by someone forgetting a `.filter`.
    .index("by_user_enabled", ["userId", "enabled"]),

  userMemories: defineTable({
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    kind: v.union(
      v.literal("preference"),
      v.literal("instruction"),
      v.literal("fact"),
      v.literal("project_context"),
    ),
    content: v.string(),
    source: v.union(v.literal("explicit"), v.literal("inferred")),
    // `user` = applies in all the user's workspaces; `workspace` = this ws only
    // (tenant-bound, so a fact learned in one workspace can't leak to another);
    // `project` = this Project only, and `projectId` is then set.
    //
    // Project scope is REAL IDENTITY, not the `project_context` kind above —
    // `kind` is a topic label anyone can pick and is not a security boundary.
    scope: v.union(
      v.literal("user"),
      v.literal("workspace"),
      v.literal("project"),
    ),
    // Set if and only if scope === "project". Derived server-side from the
    // stream's thread, never from a tool argument or a client body.
    projectId: v.optional(v.id("projects")),
    status: v.union(
      v.literal("active"),
      v.literal("disabled"),
      v.literal("superseded"),
    ),
    // Normalized content (lowercased/whitespace-collapsed) for idempotent dedup.
    // Per-user index only, so it is never a cross-user existence oracle. INTERNAL
    // — stripped from list() responses.
    normalizedKey: v.string(),
    subject: v.optional(v.string()),
    supersededBy: v.optional(v.id("userMemories")),
    sourceThreadId: v.optional(v.id("chatThreads")),
    sourceMessageId: v.optional(v.id("chatMessages")),
    reason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_status", ["userId", "status"])
    .index("by_user_scope_status", ["userId", "scope", "status"])
    .index("by_user_ws_scope_status", [
      "userId",
      "workspaceId",
      "scope",
      "status",
    ])
    .index("by_user_scope_key", ["userId", "scope", "normalizedKey"])
    // Project-scoped dedup. A SEPARATE index, because by_user_scope_key would
    // key every Project row as [userId, "project", normalizedKey] and therefore
    // collapse the SAME memory text in two different Projects into one row.
    // The dedup query in rememberFromIngress branches onto this one — adding the
    // index without branching the query would leave the collision in place.
    .index("by_user_project_key", ["userId", "projectId", "normalizedKey"])
    // Project memory retrieval (loadMemoriesForDispatch), and the index a
    // future Project purge (Phase 6) will sweep.
    .index("by_user_project_status", ["userId", "projectId", "status"]),

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
    // A short human line for the picker. Optional and additive, so rows written
    // before this existed still validate.
    description: v.optional(v.string()),
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
    // The Library file this attachment is a REFERENCE to (same blob, no copy).
    userFileId: v.optional(v.id("userFiles")),
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
    .index("by_storage", ["storageId"])
    // A Library file reused in many chats: the stream's own (blob, thread) row.
    .index("by_storage_thread", ["storageId", "threadId"])
    // Deleting a Library file removes every chat reference to it.
    .index("by_userfile", ["userFileId"]),

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

  // ── Scheduled Tasks (Phase 1) ───────────────────────────────────────────────
  // Three NEW tables; no existing table is touched. Convex is the AUTHORITATIVE
  // LEDGER for scheduled work — task config, revisions, occurrence identity and
  // execution outcome. DBOS (services/ai/app/scheduler) owns only workflow
  // execution state, and reconciliation flows Convex -> DBOS, so losing the DBOS
  // system database entirely loses NO occurrence.
  scheduledTasks: defineTable({
    userId: v.id("users"),
    // The Project this task belongs to, or absent for an ordinary task.
    // Additive: every pre-Projects task reads back undefined and runs exactly as
    // it did. Set only through scheduled.tasks.create after requireProjectAccess.
    projectId: v.optional(v.id("projects")),
    // Tenancy/billing only. Ownership is the USER, exactly like chatThreads —
    // a same-workspace peer must not see someone's scheduled prompts.
    workspaceId: v.id("workspaces"),
    title: v.string(),
    prompt: v.string(),
    spec: scheduleSpecValidator,
    status: taskStatusValidator,
    // Monotonic revision counter. An occurrence pins the revision that created
    // it, so editing a task never rewrites the meaning of past executions.
    revision: v.number(),
    // Optional ONLY because of insert ordering: a revision row needs its
    // taskId, so create() inserts the task, inserts revision 1, then patches
    // this — all inside one atomic mutation, so it is never observably absent.
    currentRevisionId: v.optional(v.id("scheduledTaskRevisions")),
    // EXCLUSIVE lower bound for occurrence enumeration, and the reason a
    // three-day outage produces three executions instead of one: the recurrence
    // timeline is preserved here, never recomputed from `now`.
    cursorAt: v.number(),
    // Advisory only (display + ordering); recomputed by the scheduler each tick
    // and therefore stale while the scheduler is down. Never an authority.
    nextRunAt: v.optional(v.number()),
    pausedAt: v.optional(v.number()),
    lastRunAt: v.optional(v.number()),
    // Phase 3 notification preferences. ABSENT MEANS ENABLED — so every task
    // created before Phase 3 notifies by default and no migration is needed.
    // Read at emit time, so toggling affects the next run and never rewrites
    // history. Cancellations follow notifyOnFailure.
    notifyOnSuccess: v.optional(v.boolean()),
    notifyOnFailure: v.optional(v.boolean()),
    // Phase 4 EMAIL preferences. Note the inverted default: ABSENT MEANS
    // DISABLED, the opposite of the in-app pair above. In-app notification is
    // free and contained; email leaves the building and cannot be recalled, so
    // deploying Phase 4 must not cause a single existing task to email anyone.
    // Kept as separate fields rather than reusing notifyOn* because success and
    // failure email have to be choosable independently of in-app notification.
    emailOnSuccess: v.optional(v.boolean()),
    emailOnFailure: v.optional(v.boolean()),
    attachPdf: v.optional(v.boolean()),
    // Phase 2: ONE dedicated execution thread per task, created lazily on the
    // first run. Optional because a task created before its first execution has
    // none, and because startRun re-creates it if it is ever trashed/purged.
    executionThreadId: v.optional(v.id("chatThreads")),
    // Why a task reached `completed` — e.g. "suppressed_by_pause" for a one-time
    // task whose only instant fell inside an intentional pause window.
    terminalReason: v.optional(v.string()),
    // Set by the scheduler when Python cannot resolve the spec (e.g. an IANA
    // zone this build's tzdata does not know). The task stops producing
    // occurrences instead of failing silently.
    invalidReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    // userId FIRST on every public index. As with chatThreads there is
    // deliberately NO workspace-only index: with none, no query shape in this
    // codebase can enumerate a tenant's scheduled tasks without pinning a user.
    .index("by_user_updated", ["userId", "updatedAt"])
    // Internal-only (the scheduler's work list, reached solely through
    // ingress-secret-gated internal mutations). Never exposed to a public query.
    .index("by_status_cursor", ["status", "cursorAt"]),

  // Immutable snapshot of a task's meaning at one revision. Occurrences point
  // here, so history never mutates: editing writes a NEW row, never a patch.
  scheduledTaskRevisions: defineTable({
    taskId: v.id("scheduledTasks"),
    userId: v.id("users"),
    // PINNED at edit time, mirroring how the prompt is pinned. An occurrence
    // executes the revision it was created under, so a task that later moves
    // Project does not retroactively change what an already-scheduled run meant.
    projectId: v.optional(v.id("projects")),
    revision: v.number(),
    title: v.string(),
    prompt: v.string(),
    spec: scheduleSpecValidator,
    createdAt: v.number(),
  }).index("by_task_revision", ["taskId", "revision"]),

  // ONE row per intended occurrence, forever. This is the "no silent loss"
  // guarantee made physical: a missed occurrence is a row that has not run yet,
  // never a counter. Retries move `attempts` and never create a second row.
  scheduledTaskOccurrences: defineTable({
    // `${taskId}:${kind}:${scheduledFor}` — deterministic and collision-safe.
    // `kind` is in the key so a "run now" in the same millisecond as a
    // scheduled instant cannot be swallowed by the idempotent insert.
    occurrenceKey: v.string(),
    taskId: v.id("scheduledTasks"),
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    // The revision this occurrence executes under — pinned at creation.
    revisionId: v.id("scheduledTaskRevisions"),
    revision: v.number(),
    scheduledFor: v.number(),
    kind: occurrenceKindValidator,
    status: occurrenceStatusValidator,
    // DISPATCH attempts (reaper requeues). Transient failures inside one
    // attempt are handled by DBOS step retries and do NOT bump this.
    attempts: v.number(),
    // Phase 2 RESULT REFERENCE — and the replay-idempotency marker. Set by
    // startRun. Their presence is what tells a DBOS-recovered workflow that this
    // occurrence already has a turn, so it resumes polling instead of starting a
    // second one. `messageId` is deliberately REUSED across dispatch attempts:
    // toolExecutions/chatStreamEvents are keyed by_message, so reusing it is what
    // lets completed + indeterminate tools be replayed rather than re-executed.
    threadId: v.optional(v.id("chatThreads")),
    messageId: v.optional(v.id("chatMessages")),
    streamId: v.optional(v.string()),
    // Backoff gate for `retrying`: the occurrence is re-claimable only once the
    // clock passes this. Retrying is a REAL occupied state between a failed
    // dispatch attempt and its requeue, not decoration.
    nextAttemptAt: v.optional(v.number()),
    // Server-minted holder token: only the current holder may advance this row.
    // The reaper rotates it on requeue so a stale worker's late write is
    // rejected. Never trusted from Python — Python only echoes it back.
    leaseToken: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    // Liveness. Deliberately on the OCCURRENCE and never on scheduledTasks:
    // a field that changes during a run must not sit on a row the task list
    // subscribes to, or every heartbeat re-sends that list to every subscriber.
    heartbeatAt: v.optional(v.number()),
    cancelRequested: v.boolean(),
    workflowId: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    errorCode: v.optional(v.string()),
    terminalReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_occurrence_key", ["occurrenceKey"])
    // Internal-only: the scheduler's global claim scan, oldest-first so a
    // backlog drains in schedule order (10:00 before 11:00 before 12:00).
    .index("by_status_scheduled", ["status", "scheduledFor"])
    .index("by_task_scheduled", ["taskId", "scheduledFor"])
    .index("by_task_status_scheduled", ["taskId", "status", "scheduledFor"])
    .index("by_user_status", ["userId", "status"])
    // Reaper: find running/queued rows whose holder stopped heartbeating.
    .index("by_status_heartbeat", ["status", "heartbeatAt"]),

  // Phase 4: ONE row per (occurrence, channel), and the delivery audit trail.
  //
  // Delivery is a SEPARATE state machine from execution, on purpose. A run that
  // produced an answer has succeeded; whether an email about it left the
  // building is a different question with different failure modes and a
  // different retry budget. Keeping them in one row would make "email failed"
  // indistinguishable from "the task failed", and would tempt a retry of the
  // whole occurrence — re-running a model turn to resend an email.
  scheduledDeliveries: defineTable({
    // The logical identity, matching the notification dedupe key: all three
    // dispatch attempts of one run collapse to a single delivery.
    occurrenceKey: v.string(),
    taskId: v.id("scheduledTasks"),
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    channel: v.literal("email"),
    // `accepted` is NOT `delivered`. A 2xx from the mail provider means it took
    // custody, nothing more; only a provider webhook can say what happened
    // next. Naming them apart is what stops the UI claiming delivery it cannot
    // observe. `indeterminate` is the honest state for a worker that died
    // between "provider accepted" and "we recorded it".
    status: v.union(
      v.literal("pending"),
      v.literal("sending"),
      v.literal("accepted"),
      v.literal("delivered"),
      v.literal("bounced"),
      v.literal("complained"),
      v.literal("failed"),
      v.literal("skipped"),
      v.literal("indeterminate"),
    ),
    pdfStatus: v.union(
      v.literal("none"),
      v.literal("succeeded"),
      v.literal("failed"),
    ),
    // Distinct from pdfStatus: a PDF can render perfectly and still be too big
    // to attach. That is a successful render with an unattached email, not a
    // failed one, and the artifact stays downloadable in-app either way.
    attachment: v.union(
      v.literal("none"),
      v.literal("attached"),
      v.literal("skipped_too_large"),
      v.literal("skipped_pdf_failed"),
    ),
    // DECISION SNAPSHOT, written inside the same transaction as the terminal
    // occurrence transition. Preferences are read once, here — never again at
    // send time. Otherwise a pref toggle, a task edit, a task deletion or an
    // email change between finalize and send would retarget or cancel work that
    // was already decided, and an account takeover could redirect a pending
    // report to a new address.
    wantEmail: v.boolean(),
    wantPdf: v.boolean(),
    recipient: v.optional(v.string()),
    outcome: v.string(),
    // `${occurrenceKey}:email` — this row's logical key.
    //
    // It is NOT sent to the provider. Ollastack has no Idempotency-Key header,
    // so there is no provider-side duplicate suppression to lean on: a crashed
    // send is resolved by scheduled/delivery.ts:reconcile, which asks the
    // provider whether the message actually exists, rather than by retrying
    // blind and hoping the provider dedupes.
    idempotencyKey: v.string(),
    providerMessageId: v.optional(v.string()),
    // Classified codes only (`provider_5xx`, `invalid_recipient`, …), never raw
    // provider text: this row is read by the UI and must not leak internals.
    errorCode: v.optional(v.string()),
    attempts: v.number(),
    claimedAt: v.optional(v.number()),
    // When reconciliation last reached a DEFINITE answer for this row from the
    // provider's outbound log. Optional and additive: pre-existing rows have no
    // value, which simply means "never reconciled". Set only on a definite
    // outcome, so a provider blip leaves the row eligible for the next pass
    // rather than silently retiring it.
    reconciledAt: v.optional(v.number()),
    pdfArtifactId: v.optional(v.id("chatArtifacts")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    // Uniqueness is NOT enforced by this index — Convex has no unique
    // constraints. It is enforced by reading through this index inside the same
    // mutation that inserts, so the read joins the transaction's read set and a
    // concurrent insert conflicts and retries. Same mechanism as notify()'s
    // dedupeKey.
    .index("by_occurrence_channel", ["occurrenceKey", "channel"])
    // Reaper: rows stuck in `sending` past their lease, and `pending` rows whose
    // scheduled action never ran (a thrown Convex action is not retried).
    .index("by_status_claimed", ["status", "claimedAt"])
    // Provider webhook: resolve an event back to its row.
    .index("by_provider_message", ["providerMessageId"])
    .index("by_user_created", ["userId", "createdAt"]),

  // MCP connections — who may use which curated MCP server, per tenant.
  //
  // ADDITIVE, so the live deployment's pre-migration rows are unaffected and
  // every field here is safe to require.
  //
  // THE TRUST MODEL IS CHAT'S, NOT THE WORKSPACE'S. Everywhere else in this
  // codebase a workspace is the boundary and any member reads any row. An MCP
  // connection is a PERSONAL ACCOUNT — someone's GitHub, their mailbox, their
  // Notion — so a same-workspace peer must be refused, exactly as chat threads
  // refuse one. `workspaceId` is carried for tenancy and for the requireMember
  // check, never as the read boundary. Hence every index leads with userId, and
  // there is deliberately NO workspace-only index that could enumerate a
  // tenant's connections without pinning a user first.
  //
  // NO CREDENTIAL FIELD, and there never will be one. Phase 4 owns credentials,
  // in a vault; a token on this row would be readable by every code path that
  // can read a connection.
  //
  // NO LIVE SESSION STATE EITHER. `status` is the lifecycle verdict, not a
  // socket: the MCP client, its transport and its session id live only in the
  // Python plane's in-memory pool and are never serialized here.
  mcpConnections: defineTable({
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    // The registry's reverse-DNS identity (e.g. "ac.inference.sh/mcp"), which
    // the curated table and the catalogue are both keyed on.
    serverName: v.string(),
    // Denormalized for display, and because every tool_id is namespaced with it.
    slug: v.string(),
    // EXPLICIT, and never rewritten by a catalogue sync. A server publishing a
    // new latest_version must not silently re-point a live connection at a
    // different build.
    version: v.string(),
    versionMode: v.union(v.literal("pinned"), v.literal("latest_at_connect")),
    transport: v.union(v.literal("streamable-http"), v.literal("sse")),
    authKind: v.string(),
    // Lifecycle verdict. `disconnected` is what suppresses automatic
    // reconnection: a connection the user explicitly closed must stay closed.
    status: v.union(
      v.literal("configured"),
      v.literal("ready"),
      v.literal("degraded"),
      v.literal("failed"),
      v.literal("disconnected"),
      v.literal("unsupported"),
    ),
    lastConnectedAt: v.optional(v.number()),
    lastFailureAt: v.optional(v.number()),
    // Classified, bounded and sanitized in the Python plane before it arrives:
    // a kind plus a short detail, never a header value, a payload, or a
    // resolved IP address.
    lastError: v.optional(v.string()),
    lastErrorKind: v.optional(v.string()),
    // Whether a human has to act (reconnect an account) rather than this being
    // transient. The difference between "retrying..." and "your token expired".
    userActionRequired: v.optional(v.boolean()),
    // Bounded JSON SUMMARY of the capability snapshot — counts and flags, not
    // the tool list. Same convention as seoMutations.before/after and
    // chatShares: a string, never v.any(), so a hostile server cannot push
    // schema shape into Convex.
    capabilities: v.optional(v.string()),
    capabilitiesAt: v.optional(v.number()),
    toolCount: v.optional(v.number()),
    // The tool NAMES, for the detail page's "what can this do?" list. Already
    // computed by the Python plane on every connect and previously discarded.
    //
    // BOUNDED, AND DELIBERATELY NOT ON `listWithAuth`. A server may advertise up
    // to `mcp_max_tools_per_server` (256) tools, and this table is read by a
    // LIST query whose whole result is re-sent to every subscriber on any write.
    // So the array is capped when written, and `listWithAuth` projects it away —
    // only `connections.get`, which returns one row for one open detail page,
    // carries it. `toolCount` remains the authority on how many there are, so a
    // truncated list can say so instead of quietly under-reporting.
    toolNames: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_server", ["userId", "serverName"])
    .index("by_user_workspace", ["userId", "workspaceId"]),

  // MCP credentials — CIPHERTEXT ONLY.
  //
  // TENANT-SCOPED, same trust model as mcpConnections: a credential is a
  // personal account, so a same-workspace peer is refused and every index leads
  // with userId. There is deliberately NO workspace-only index.
  //
  // `envelope` is the ONLY secret-bearing field, and it is AES-256-GCM
  // ciphertext produced in the Python plane. Its AAD binds
  // user|workspace|connection|server|resource, so a row copied into another
  // user's record fails to decrypt EVEN WITH THE KEY. Encryption is
  // defence-in-depth behind the owner checks below, never a replacement for
  // them — this table is secret storage, not ordinary application data.
  //
  // EVERYTHING ELSE IS PLAINTEXT ON PURPOSE. `expiresAt` and `scope` are not
  // secrets, and the refresh path asks "is this expired?" on every call;
  // requiring a decryption for that would be a needless use of the key.
  mcpCredentials: defineTable({
    // Opaque, PYTHON-MINTED, and not the Convex _id: the AAD must exist before
    // the first insert, so the id cannot be one Convex assigns afterwards.
    credentialId: v.string(),
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    connectionId: v.id("mcpConnections"),
    serverName: v.string(),
    // The canonical MCP resource URI. THE audience key: a token issued for one
    // MCP server must never be found by a lookup for another (RFC 8707).
    resource: v.string(),
    kind: v.union(
      v.literal("oauth_token"),
      v.literal("api_key"),
      v.literal("bearer"),
    ),
    envelope: v.string(),
    keyVersion: v.number(),
    // ABSOLUTE. The SDK's OAuthToken carries a RELATIVE expires_in and does not
    // recompute expiry on load, so storing the relative value would make a
    // token issued an hour ago look fresh forever.
    expiresAt: v.optional(v.number()),
    scope: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("expired"),
      v.literal("refresh_failed"),
      v.literal("revoked"),
      // Decryption failed. The row is KEPT: deleting would destroy the evidence
      // that something was tampered with, or that a key version was retired
      // while rows still used it.
      v.literal("unreadable"),
    ),
    // Compare-and-set guard. Refresh-token rotation invalidates the old token
    // as it issues the new one, so a stale writer overwriting a newer row costs
    // the user a re-authorization. This makes the stale writer lose.
    rev: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_credential_id", ["credentialId"])
    .index("by_connection_resource", ["connectionId", "resource", "kind"]),

  // OAuth client registrations — DEPLOYMENT-scoped, not tenant-scoped.
  //
  // A dynamically-registered client is registered once per (server, issuer) and
  // reused by EVERY user of that server, so it has no owner. That is exactly
  // why it lives here rather than as a `kind` on mcpCredentials: a nullable
  // userId would make that table's owner check incoherent.
  //
  // The client_secret inside `envelope` is encrypted identically to a token. It
  // is a credential, and "configuration" is not a safe place to keep one.
  mcpOAuthClients: defineTable({
    clientRecordId: v.string(),
    serverName: v.string(),
    issuer: v.string(),
    envelope: v.string(),
    keyVersion: v.number(),
    registrationMode: v.union(
      v.literal("dcr"),
      v.literal("cimd"),
      v.literal("preregistered"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_server_issuer", ["serverName", "issuer"]),
});
