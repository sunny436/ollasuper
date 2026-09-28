"use client";

import { QUOTA_LABEL, fmtBytes } from "@/lib/library";
import { api } from "@v1/backend/convex/_generated/api";
import { useQuery } from "convex/react";

/**
 * "64 MB of 100 MB used · Free up space". Counts UPLOADS only, across every
 * workspace — generated files are free and never deleted to make room.
 */
export function StorageMeter({ onFreeUp }: { onFreeUp: () => void }) {
  const s = useQuery(api.library.storageSummary, {});
  if (!s) return <div className="h-5" aria-hidden />;
  const pct = Math.min(100, Math.round((s.usedBytes / Math.max(1, s.quotaBytes)) * 100));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div
        className="h-1 w-48 max-w-full overflow-hidden rounded-full bg-primary/10"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Library storage used"
      >
        <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-primary/65">
        <span className={s.nearFull ? "text-destructive" : undefined}>
          {fmtBytes(s.usedBytes)} of {QUOTA_LABEL} used
        </span>
        {" · "}
        <button
          type="button"
          onClick={onFreeUp}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          Free up space
        </button>
      </p>
    </div>
  );
}
