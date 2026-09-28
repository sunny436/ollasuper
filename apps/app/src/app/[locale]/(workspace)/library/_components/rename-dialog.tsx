"use client";

import { Button } from "@v1/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@v1/ui/dialog";
import { useState } from "react";

/** Rename a Library file. Only the name changes — a file's bytes never do. */
export function RenameDialog({
  name,
  onClose,
  onSave,
}: {
  name: string | null;
  onClose: () => void;
  onSave: (next: string) => Promise<void>;
}) {
  return (
    <Dialog open={name !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="workspace sm:max-w-md">
        {name !== null && <RenameForm initial={name} onClose={onClose} onSave={onSave} />}
      </DialogContent>
    </Dialog>
  );
}

// Module scope: the input must not remount while typing.
function RenameForm({
  initial,
  onClose,
  onSave,
}: {
  initial: string;
  onClose: () => void;
  onSave: (next: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const trimmed = value.trim();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!trimmed || trimmed === initial) return onClose();
        setBusy(true);
        try {
          await onSave(trimmed);
          onClose();
        } finally {
          setBusy(false);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle className="text-base">Rename file</DialogTitle>
      </DialogHeader>
      <input
        // biome-ignore lint/a11y/noAutofocus: the dialog exists to type a name
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={255}
        aria-label="File name"
        className="mt-4 w-full rounded-lg border border-border bg-card px-3 py-2 text-base text-primary outline-none focus:border-brand md:text-sm"
      />
      <DialogFooter className="mt-4 gap-2">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !trimmed}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
