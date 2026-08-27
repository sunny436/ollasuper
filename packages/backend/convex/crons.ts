import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Finalize streams whose Python worker died mid-generation.
 *
 * This is the only thing that recovers a SIGKILLed inference process: no
 * in-process `finally:` runs in that case, and systemd restarts the service
 * with an empty task registry, so nothing on the Python side knows the stream
 * ever existed. Without this a message spins forever.
 */
crons.interval(
  "reap stalled chat streams",
  { seconds: 60 },
  internal.chat.stream.reapStalled,
  {},
);

crons.interval(
  "reap stalled file ingestions",
  { seconds: 60 },
  internal.userFiles.reapStalled,
  {},
);

/**
 * Expire tool-approval requests that sat unanswered past their TTL (Phase 8).
 * An expired approval terminates the parked turn — the tool must NOT run — and
 * is separate from the stall reaper because a `waiting_approval` stream is
 * deliberately invisible to the running/queued stall scan.
 */
crons.interval(
  "reap expired chat approvals",
  { seconds: 60 },
  internal.chat.approvals.reapExpired,
  {},
);

/** Hard-delete conversations that have sat in the trash past the retention TTL. */
crons.interval(
  "purge trashed chat threads",
  { hours: 6 },
  internal.chat.threads.purgeTrashed,
  {},
);

/**
 * Auth security history retention. IP prefixes and user-agents are the only
 * personal data in authEvents, so they do not accumulate indefinitely: 90 days
 * is long enough to investigate an incident and short enough to be defensible.
 */
crons.interval(
  "purge old auth events",
  { hours: 24 },
  internal.authEventsPurge.purgeOld,
  {},
);

/**
 * Keep the OpenRouter catalogue fresh.
 *
 * 6h rather than hourly: the model list changes on the order of days, and the
 * refresh rewrites up to ~400 rows. chat/models.ts:apply refuses to apply an
 * implausibly short response, so a bad fetch keeps the previous catalogue
 * rather than emptying it.
 */
crons.interval(
  "refresh openrouter model catalogue",
  { hours: 6 },
  internal.chat.models.refresh,
  {},
);

// Phase 4 — reap expired pending OAuth requests (short-TTL, one-time) and retry any
// connector disconnects whose Google revoke transiently failed.
crons.interval(
  "reap expired connector auth requests",
  { minutes: 5 },
  internal.connectors.reapAuthRequests,
  {},
);
crons.interval(
  "retry pending connector revokes",
  { minutes: 5 },
  internal.connectors.retryPendingRevoke,
  {},
);

// Phase 5 — recover durable SEO runs whose worker died (the only thing that resumes a
// SIGKILLed run: no in-process finally runs, and the seo_registry restarts empty).
// Scans EVERY non-terminal state (running/queued/retry_wait) so a lost redispatch is
// still reaped. Cheap: one small doc per run.
crons.interval(
  "reap stalled seo runs",
  { seconds: 60 },
  internal.seoRuns.reapStalledRuns,
  {},
);

// Phase 5 — reclaim compressed crawl-artifact blobs of abandoned terminal runs (a
// crashed run never reaches the finalize cleanup path).
crons.interval(
  "gc abandoned seo run artifacts",
  { minutes: 5 },
  internal.seoRuns.gcTerminalArtifacts,
  {},
);

export default crons;
