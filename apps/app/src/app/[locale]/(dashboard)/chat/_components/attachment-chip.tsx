"use client";

import { FileText, Loader2, X } from "lucide-react";
import type { PendingAttachment } from "../_hooks/use-attachments";
import { fmtSize } from "../_lib/format";

export function AttachmentChip({
  item,
  onRemove,
}: {
  item: PendingAttachment;
  onRemove: (localId: string) => void;
}) {
  return (
    <div
      className={`relative flex items-center gap-2 overflow-hidden rounded-lg border bg-background px-2 py-1.5 text-xs ${
        item.status === "error" ? "border-destructive/40" : "border-border"
      }`}
    >
      {item.isImage && item.previewUrl ? (
        <img
          src={item.previewUrl}
          alt={item.name}
          className="h-7 w-7 shrink-0 rounded object-cover"
        />
      ) : (
        <FileText className="h-4 w-4 shrink-0 text-primary/40" />
      )}

      <span className="max-w-[10rem] truncate text-primary/80">{item.name}</span>
      <span className="shrink-0 text-primary/35">{fmtSize(item.size)}</span>

      {item.status === "uploading" && (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary/40" />
      )}

      <button
        type="button"
        onClick={() => onRemove(item.localId)}
        aria-label={`Remove ${item.name}`}
        className="shrink-0 rounded p-0.5 text-primary/35 transition hover:bg-primary/10 hover:text-primary/70"
      >
        <X className="h-3 w-3" />
      </button>

      {item.status === "uploading" && (
        <span
          className="absolute bottom-0 left-0 h-0.5 bg-brand transition-all"
          style={{ width: `${item.progress}%` }}
        />
      )}
    </div>
  );
}
