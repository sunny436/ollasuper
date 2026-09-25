import { describe, expect, test } from "bun:test";
import { runErrorCopy, taskInvalidCopy } from "./schedule-format";

// Every message `parse_spec` can record as a task's invalidReason
// (services/ai/app/scheduler/recurrence.py). The generic "The run did not
// complete." once stood in for all of them, which is what kept the 2026-09-22
// "invalid hour" outage invisible for three days.
const SPEC_REASONS = [
  "missing timezone",
  "unknown timezone: Mars/Olympus",
  "missing runAt",
  "invalid hour",
  "invalid minute",
  "invalid endsAt",
  "invalid weekdays",
  "invalid dayOfMonth",
  "unknown kind: 'hourly'",
];

describe("taskInvalidCopy", () => {
  test("a schedule the scheduler could not read names the reason and the fix", () => {
    for (const reason of SPEC_REASONS) {
      const copy = taskInvalidCopy(reason);
      expect(copy).toContain(`(${reason})`);
      expect(copy).toContain("Edit the schedule and save it");
    }
  });

  test("any other code falls through to the run-failure copy", () => {
    expect(taskInvalidCopy("owner_not_member")).toBe(
      "The task's owner no longer has access to this workspace.",
    );
  });
});

describe("runErrorCopy", () => {
  test("an unmapped code is named, never hidden", () => {
    expect(runErrorCopy("sandbox_oom")).toBe("The run did not complete (sandbox_oom).");
  });

  test("no code at all keeps the plain sentence", () => {
    expect(runErrorCopy(null)).toBe("The run did not complete.");
  });
});
