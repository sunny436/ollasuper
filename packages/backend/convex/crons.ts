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

export default crons;
