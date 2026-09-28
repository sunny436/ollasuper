"use client";

import {
  type CandidateSort,
  QUOTA_LABEL,
  type SpaceReason,
  fmtBytes,
  preselect,
  selectedBytes,
  sortCandidates,
} from "@/lib/library";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { Button } from "@v1/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@v1/ui/dialog";
import { useQuery } from "convex/react";
import { useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set when the panel was opened by an upload that does not fit. */
  pending?: { fileName: string; size: number; reason: SpaceReason } | null;
  /**
   * Upload flow: continue the upload with these approved deletions.
   * Manual flow (storage meter): delete these now.
   */
  onConfirm: (ids: Id<"userFiles">[]) => Promise<void>;
};

/**
 * "Free up space" — the only way a Library file is ever deleted to make room,
 * and it is always the user's choice. The oldest uploads are pre-selected just
 * enough to fit; the user can change the selection freely. Generated files and
 * files in a Project are never offered (the server would refuse them anyway).
 *
 * Reads the candidates LIVE, so a file deleted in another tab disappears here.
 */
export function FreeUpSpaceDialog({ open, onOpenChange, pending, onConfirm }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workspace sm:max-w-lg">
        {open && (
          <Panel pending={pending ?? null} onConfirm={onConfirm} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Panel({
  pending,
  onConfirm,
  onClose,
}: {
  pending: Props["pending"] | null;
  onConfirm: Props["onConfirm"];
  onClose: () => void;
}) {
  const data = useQuery(api.library.freeUpCandidates, { needBytes: pending?.size ?? 0 });
  const [sort, setSort] = useState<CandidateSort>("oldest");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);

  const files = data?.files ?? [];
  const plan = data?.plan;
  const shortBytes = pending ? (plan?.shortBytes ?? 0) : 0;
  // The default selection is derived, not stored, until the user touches it.
  const selected = picked ?? new Set<string>(preselect(files, shortBytes));
  const freeing = selectedBytes(files, selected);
  const enough = pending ? selected.size > 0 && freeing >= shortBytes : selected.size > 0;
  const cannotFit = pending != null && plan != null && !plan.canFit;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const heading = pending
    ? pending.reason === "QUOTA_PLAN_CHANGED"
      ? "Your files changed — choose again"
      : `Not enough space for ${pending.fileName}`
    : "Free up space";

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-base">{heading}</DialogTitle>
        <DialogDescription>
          {pending
            ? `It needs ${fmtBytes(pending.size)}. Choose files to delete to make room. Nothing is deleted until you confirm.`
            : `Your uploads count towards ${QUOTA_LABEL}. Generated files and files in Projects don't appear here and are never deleted to make room.`}
        </DialogDescription>
      </DialogHeader>

      {plan && <UsageBar used={plan.usedBytes} quota={plan.quotaBytes} />}

      {cannotFit ? (
        <p className="rounded-xl border border-border px-4 py-3 text-sm text-primary/80">
          Your {QUOTA_LABEL} is used by files in Projects. Remove some files from a
          Project to upload this one.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-primary/65">
            <span>
              {pending
                ? `Frees ${fmtBytes(freeing)} of ${fmtBytes(shortBytes)} needed`
                : `${selected.size} selected · frees ${fmtBytes(freeing)}`}
            </span>
            <div className="flex gap-1" role="group" aria-label="Sort files">
              {(["oldest", "largest"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={sort === s}
                  onClick={() => setSort(s)}
                  className={`rounded-full px-2.5 py-1 capitalize transition ${
                    sort === s ? "bg-primary/10 text-primary" : "hover:bg-accent"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <ul className="scrollbar-quiet max-h-72 divide-y divide-border/60 overflow-y-auto rounded-xl border border-border">
            {data === undefined && <li className="px-4 py-6 text-center text-sm text-primary/60">Loading…</li>}
            {data !== undefined && files.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-primary/60">
                Nothing can be deleted to make room.
              </li>
            )}
            {sortCandidates(files, sort).map((f) => (
              <li key={f._id}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-accent [@media(pointer:coarse)]:min-h-11">
                  <input
                    type="checkbox"
                    checked={selected.has(f._id)}
                    onChange={() => toggle(f._id)}
                    className="h-4 w-4 accent-brand"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-primary/90" title={f.name}>
                      {f.name}
                    </span>
                    <span className="text-xs text-primary/60">
                      {fmtBytes(f.size)} · {new Date(f.createdAt).toLocaleDateString()}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {!cannotFit && (
          <Button
            variant="destructive"
            disabled={!enough || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(files.filter((f) => selected.has(f._id)).map((f) => f._id));
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Working…" : pending ? "Delete selected and upload" : "Delete selected"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function UsageBar({ used, quota }: { used: number; quota: number }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, quota)) * 100));
  return (
    <div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-primary/10"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Storage used"
      >
        <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-primary/65">
        {fmtBytes(used)} of {QUOTA_LABEL} used
        {pct >= 90 && <span className="text-destructive"> · almost full</span>}
      </p>
    </div>
  );
}
