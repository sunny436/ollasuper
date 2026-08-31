"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@v1/ui/dialog";
import { Switch } from "@v1/ui/switch";
import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * Per-task delivery preferences: in-app notifications, and email.
 *
 * THE TWO GROUPS DEFAULT OPPOSITE WAYS, on purpose. In-app notifications
 * default ON — the backend treats an absent value as enabled, so tasks created
 * before they existed keep notifying with no migration, and a notification is
 * free and contained. Email defaults OFF and is strictly opt-in, because it
 * leaves the building and cannot be recalled: turning the feature on must not
 * make one existing task mail anyone.
 *
 * Changing any of these affects FUTURE runs only. The decision for a run is
 * snapshotted the moment it finishes, so a toggle can never retarget or cancel
 * a report that is already on its way.
 */

type PrefTask = {
  _id: Id<"scheduledTasks">;
  title: string;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  emailOnSuccess: boolean;
  emailOnFailure: boolean;
  attachPdf: boolean;
};

type Prefs = {
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  emailOnSuccess: boolean;
  emailOnFailure: boolean;
  attachPdf: boolean;
};

export function NotifyPrefsPopover({
  task,
  open,
  onOpenChange,
}: {
  task: PrefTask;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const setPrefs = useMutation(api.scheduled.tasks.setNotifyPrefs);
  const [prefs, setPrefsState] = useState<Prefs>({
    notifyOnSuccess: task.notifyOnSuccess,
    notifyOnFailure: task.notifyOnFailure,
    emailOnSuccess: task.emailOnSuccess,
    emailOnFailure: task.emailOnFailure,
    attachPdf: task.attachPdf,
  });

  async function update(patch: Partial<Prefs>) {
    const previous = prefs;
    setPrefsState({ ...prefs, ...patch });
    try {
      await setPrefs({ taskId: task._id, ...patch });
    } catch {
      // Optimistic, so roll back rather than leaving the switch lying about
      // what the server actually holds.
      setPrefsState(previous);
      toast.error("Couldn't save notification settings");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workspace sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Notifications</DialogTitle>
          <DialogDescription>
            Updates for “{task.title}”. Changes apply to future runs.
          </DialogDescription>
        </DialogHeader>

        <PrefGroup label="In OllaSuper">
          <PrefRow
            label="When a run completes"
            checked={prefs.notifyOnSuccess}
            onChange={(v) => update({ notifyOnSuccess: v })}
          />
          <PrefRow
            label="When a run fails or is cancelled"
            checked={prefs.notifyOnFailure}
            onChange={(v) => update({ notifyOnFailure: v })}
          />
        </PrefGroup>

        <PrefGroup
          label="By email"
          hint="Sent to your account's verified address. Nobody else can be added."
        >
          <PrefRow
            label="When a run completes"
            checked={prefs.emailOnSuccess}
            onChange={(v) => update({ emailOnSuccess: v })}
          />
          <PrefRow
            label="When a run fails or is cancelled"
            checked={prefs.emailOnFailure}
            onChange={(v) => update({ emailOnFailure: v })}
          />
          <PrefRow
            label="Attach a PDF report"
            // A failed run has no result to render, so the attachment only ever
            // applies to a successful one — say so rather than letting someone
            // wonder why a failure email arrived bare.
            hint="Successful runs only. A large report stays downloadable here instead of being attached."
            checked={prefs.attachPdf}
            disabled={!prefs.emailOnSuccess}
            onChange={(v) => update({ attachPdf: v })}
          />
        </PrefGroup>
      </DialogContent>
    </Dialog>
  );
}

/** Module scope, never nested — a nested sub-component remounts every render. */
function PrefGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      {hint && <p className="mt-1 text-xs text-primary/50">{hint}</p>}
      <div className="mt-1 divide-y divide-border/60">{children}</div>
    </div>
  );
}

function PrefRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-4 py-3 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      <span className="min-w-0">
        <span className="block text-sm text-primary/85">{label}</span>
        {hint && (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </label>
  );
}
