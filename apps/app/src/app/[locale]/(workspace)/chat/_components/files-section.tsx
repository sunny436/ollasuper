"use client";

import { ConfirmButton } from "@/components/confirm-button";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, usePaginatedQuery } from "convex/react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { fmtSize } from "../_lib/format";

type FileRow = {
  _id: Id<"userFiles">;
  name: string;
  size: number;
  status: "processing" | "ready" | "failed";
  error: string | null;
  detectedType: string | null;
};

/**
 * Account-level Files: the per-user knowledge base surfaced in the chat rail.
 * List + status + delete ONLY — uploads happen exclusively through the chat
 * composer paperclip (see use-attachments.ts), never here. Reactive via
 * usePaginatedQuery: status flips Processing -> Ready with no reload.
 * Sub-components are module-scope (never nested) per the focus/IME rule.
 */
export function FilesSection() {
  const { current } = useWorkspace();
  const [open, setOpen] = useState(false);
  const removeFile = useMutation(api.userFiles.remove);

  const { results, status, loadMore } = usePaginatedQuery(
    api.userFiles.list,
    current ? { workspaceId: current } : "skip",
    { initialNumItems: 20 },
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center justify-between rounded-lg px-2 py-1.5 transition-colors hover:bg-accent"
      >
        <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          Files
          {results.length > 0 && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-muted-foreground">
              {results.length}
            </span>
          )}
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-primary" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-primary" />
        )}
      </button>

      {/* ~6 rows visible, then scroll — the account knowledge base as a compact
          dropdown directly under New chat. */}
      {open && (
        <div className="mt-1 max-h-64 overflow-y-auto pb-1">
          {results.map((f) => (
            <FileItem
              key={f._id}
              file={f as FileRow}
              onDelete={async () => {
                await removeFile({ fileId: f._id });
                toast.success("Deleted");
              }}
            />
          ))}

          {status === "CanLoadMore" && (
            <button
              type="button"
              onClick={() => loadMore(20)}
              className="mt-1 w-full rounded-md px-2 py-1 text-[11px] text-primary/50 transition hover:bg-primary/5"
            >
              Load more
            </button>
          )}

          {results.length === 0 && status !== "LoadingFirstPage" && (
            <p className="px-2 py-2 text-[11px] leading-relaxed text-primary/35">
              No files yet. Attach a file in chat and it becomes knowledge the
              assistant can use across every conversation.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function FileItem({
  file,
  onDelete,
}: {
  file: FileRow;
  onDelete: () => Promise<void>;
}) {
  return (
    <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent">
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-primary" title={file.name}>
          {file.name}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {fmtSize(file.size)}
          {file.detectedType ? ` · ${file.detectedType}` : ""}
        </p>
      </div>
      <StatusBadge status={file.status} error={file.error} />
      <ConfirmButton
        label={<Trash2 className="h-3.5 w-3.5" />}
        title="Delete file?"
        description={file.name}
        confirmLabel="Delete"
        className="text-primary/30 opacity-0 transition hover:text-destructive group-hover:opacity-100"
        onConfirm={onDelete}
      />
    </div>
  );
}

function StatusBadge({
  status,
  error,
}: {
  status: FileRow["status"];
  error: string | null;
}) {
  if (status === "ready") {
    return (
      <span className="rounded border border-brand/25 bg-brand/10 px-1.5 py-px text-[9px] font-semibold text-brand-ink">
        Ready
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        title={error ?? undefined}
        className="inline-flex items-center gap-0.5 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-px text-[9px] font-semibold text-destructive"
      >
        <AlertCircle className="h-2.5 w-2.5" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 rounded border border-border bg-primary/5 px-1.5 py-px text-[9px] font-medium text-primary/50">
      <Loader2 className="h-2.5 w-2.5 animate-spin" />
      Processing
    </span>
  );
}
