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

/**
 * Scheduled Tasks: recover occurrences whose scheduler process died.
 *
 * DBOS recovers its own interrupted workflows on restart, but nothing recovers
 * an occurrence whose holder was SIGKILLed and whose DBOS system database is
 * unreachable or was rebuilt. This is the independent backstop, and it rotates
 * the lease so the dead holder can never advance the row afterwards. Same role
 * as "reap stalled chat streams" above.
 */
crons.interval(
  "reap stalled scheduled occurrences",
  { seconds: 60 },
  internal.scheduled.occurrences.reapStalled,
  {},
);

/**
 * Scheduled Tasks: drive report delivery forward.
 *
 * This is not a tidy-up — it is the RETRY MECHANISM. A Convex action that
 * throws is not retried, so a delivery whose action died leaves a row in
 * `sending` (or a `pending` row nothing ever picked up) that only this cron
 * will ever move again. Same role `dispatch` gives "reap stalled chat streams".
 */
crons.interval(
  "reap scheduled deliveries",
  { seconds: 60 },
  internal.scheduled.delivery.reap,
  {},
);

/**
 * Scheduled Tasks: find out what actually happened to a report email.
 *
 * SEPARATE from the reaper above, deliberately. `reap` is a mutation and the
 * retry mechanism, so it cannot make network calls, and a fault in
 * reconciliation must never be able to break retries.
 *
 * Ollastack accepts a send and reports `sent`/`failed` afterwards, with no
 * delivery webhook and no bounce feed. Without this pass, a send that was
 * accepted and then failed — and any send whose worker died before recording
 * the provider id — is a silent failure. 5 minutes rather than 60 seconds: this
 * upgrades accuracy after the fact, it is never on the critical path, and rows
 * are ignored until they are a minute old anyway.
 */
crons.interval(
  "reconcile scheduled deliveries",
  { minutes: 5 },
  internal.scheduled.delivery.reconcile,
  {},
);

export default crons;
