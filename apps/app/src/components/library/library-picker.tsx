"use client";

import { InfiniteSentinel } from "@/components/infinite-sentinel";
import { fmtBytes } from "@/lib/library";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@v1/ui/dialog";
import { usePaginatedQuery } from "convex/react";
import { FileImage, FileText, Search } from "lucide-react";
import { useEffect, useState } from "react";

export type PickedFile = { _id: Id<"userFiles">; name: string; size: number; kind: string };

/**
 * "Add from Library" — pick one of your own files to attach. The list and the
 * name search come from the server (library.list); the file is attached by
 * REFERENCE (chat.attachments.attachLibraryFile), with no upload and no copy.
 */
export function LibraryPicker({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (file: PickedFile) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workspace sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Add from Library</DialogTitle>
          <DialogDescription>Attach a file you already have — nothing is uploaded again.</DialogDescription>
        </DialogHeader>
        {open && (
          <PickerList
            onPick={(f) => {
              onPick(f);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// Module scope: the search input must not remount while typing.
function PickerList({ onPick }: { onPick: (f: PickedFile) => void }) {
  const { current } = useWorkspace();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const { results, status, loadMore } = usePaginatedQuery(
    api.library.list,
    current ? { workspaceId: current, ...(search ? { search } : {}) } : "skip",
    { initialNumItems: 20 },
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          // biome-ignore lint/a11y/noAutofocus: the picker opens to search
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search file names"
          aria-label="Search file names"
          className="w-full rounded-full border border-border bg-card py-2 pl-9 pr-3 text-base text-primary outline-none focus:border-brand md:text-sm"
        />
      </div>
      <div className="scrollbar-quiet max-h-80 overflow-y-auto rounded-xl border border-border">
      <ul className="divide-y divide-border/60">
        {status === "LoadingFirstPage" && (
          <li className="px-4 py-6 text-center text-sm text-primary/60">Loading…</li>
        )}
        {status !== "LoadingFirstPage" && results.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-primary/60">
            {search ? "No files match." : "Your Library is empty."}
          </li>
        )}
        {results.map((f) => {
          // A chat can read documents, images and text; an archive or other
          // binary can only be downloaded.
          const readable = f.kind !== "other" && f.hasBlob;
          const Icon = f.kind === "image" ? FileImage : FileText;
          return (
            <li key={f._id}>
              <button
                type="button"
                disabled={!readable}
                onClick={() => onPick({ _id: f._id, name: f.name, size: f.size, kind: f.kind })}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11"
              >
                <Icon className="h-4 w-4 shrink-0 text-primary/55" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-primary/90">{f.name}</span>
                  <span className="text-xs text-primary/60">
                    {fmtBytes(f.size)}
                    {readable ? "" : " · can't be read in a chat"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <InfiniteSentinel status={status} loadMore={loadMore} pageSize={20} className="py-2" />
      </div>
    </div>
  );
}
