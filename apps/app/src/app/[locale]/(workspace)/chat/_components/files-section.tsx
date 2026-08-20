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
  Upload,
} from "lucide-react";
import { type ChangeEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { fmtSize } from "../_lib/format";

const MAX_BYTES = 20 * 1024 * 1024;

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

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
 * Uploads become retrievable across EVERY conversation (not just this one).
 * Reactive via usePaginatedQuery — status flips Processing -> Ready with no
 * reload. Sub-components are module-scope (never nested) per the focus/IME rule.
 */
export function FilesSection() {
  const { current } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const generateUploadUrl = useMutation(api.userFiles.generateUploadUrl);
  const saveFile = useMutation(api.userFiles.saveFile);
  const removeFile = useMutation(api.userFiles.remove);

  const { results, status, loadMore } = usePaginatedQuery(
    api.userFiles.list,
    current ? { workspaceId: current } : "skip",
    { initialNumItems: 20 },
  );

  const onUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !current) return;
    if (file.size > MAX_BYTES) {
      toast.error("File is larger than 20MB");
      return;
    }
    setBusy(true);
    try {
      const contentType = file.type || "application/octet-stream";
      const contentHash = await sha256Hex(file);
      const url = await generateUploadUrl({ workspaceId: current });
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": contentType },
        body: file,
      });
      const { storageId } = await res.json();
      await saveFile({
        workspaceId: current,
        storageId,
        name: file.name,
        size: file.size,
        contentType,
        contentHash,
      });
      if (inputRef.current) inputRef.current.value = "";
      toast.success(`Added ${file.name}`);
      setOpen(true);
    } catch {
      toast.error("Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-primary/35 transition hover:text-primary/60"
      >
        <span>Files</span>
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </button>

      {open && (
        <div className="max-h-56 overflow-y-auto px-2 pb-2">
          <label className="mb-1 flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-primary/70 transition hover:bg-primary/5">
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5 text-brand-ink" />
            )}
            {busy ? "Uploading…" : "Upload a file"}
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              onChange={onUpload}
              disabled={busy || !current}
            />
          </label>

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
              No files yet. Upload one to give the assistant knowledge across
              every chat.
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
    <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-primary/5">
      <FileText className="h-3.5 w-3.5 shrink-0 text-primary/40" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-primary" title={file.name}>
          {file.name}
        </p>
        <p className="text-[10px] text-primary/35">
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
