"use client";

import { fmtBytes } from "@/lib/library";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@v1/ui/dropdown-menu";
import {
  AlertCircle,
  Download,
  ExternalLink,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Presentation,
  RotateCcw,
  Sparkles,
  Trash2,
} from "lucide-react";

/** The server's client-facing row (library.toLibraryRow). */
export type LibraryRow = {
  _id: Id<"userFiles">;
  name: string;
  size: number;
  kind: "image" | "pdf" | "document" | "spreadsheet" | "presentation" | "text" | "other";
  source: "uploaded" | "generated";
  status: "processing" | "ready" | "failed" | "stored";
  error: string | null;
  /** Failure lifecycle (libraryProcessing): an automatic retry is scheduled
   *  for `retryAt`, or the file gave up (`deadLettered`) and waits for the user. */
  retryAt?: number | null;
  deadLettered?: boolean;
  progress: number | null;
  stageMessage: string | null;
  note: string | null;
  hasBlob: boolean;
  canPreview: boolean;
  createdAt: number;
};

export type FileActions = {
  onOpen: (f: LibraryRow) => void;
  onDownload: (f: LibraryRow) => void;
  onRename: (f: LibraryRow) => void;
  onAddToChat: (f: LibraryRow) => void;
  onDelete: (f: LibraryRow) => void;
  onRetry: (f: LibraryRow) => void;
  /** A thumbnail URL for a previewable image, when one is minted. */
  previewUrl: (f: LibraryRow) => string | undefined;
  onPreviewError: (f: LibraryRow) => void;
};

const KIND_ICON = {
  image: FileImage,
  pdf: FileText,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  text: FileText,
  other: FileIcon,
} as const;

const KIND_LABEL = {
  image: "Image",
  pdf: "PDF",
  document: "Document",
  spreadsheet: "Spreadsheet",
  presentation: "Presentation",
  text: "Text",
  other: "File",
} as const;

// Module scope, never nested: a nested sub-component remounts on every render.

export function FileCard({ file, actions }: { file: LibraryRow; actions: FileActions }) {
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-border bg-card transition hover:border-primary/25">
      <button
        type="button"
        onClick={() => actions.onOpen(file)}
        aria-label={`Open ${file.name}`}
        className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-primary/[0.03]"
      >
        <Thumb file={file} actions={actions} large />
      </button>
      <div className="flex items-start gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-primary" title={file.name}>
            {file.name}
          </p>
          <Meta file={file} />
        </div>
        <FileMenu file={file} actions={actions} />
      </div>
    </div>
  );
}

export function FileListRow({ file, actions }: { file: LibraryRow; actions: FileActions }) {
  return (
    <div className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent">
      <button
        type="button"
        onClick={() => actions.onOpen(file)}
        aria-label={`Open ${file.name}`}
        className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-primary/[0.03]"
      >
        <Thumb file={file} actions={actions} />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-primary" title={file.name}>
          {file.name}
        </p>
        <Meta file={file} />
      </div>
      <span className="hidden w-28 shrink-0 text-xs text-primary/60 sm:block">
        {new Date(file.createdAt).toLocaleDateString()}
      </span>
      <FileMenu file={file} actions={actions} />
    </div>
  );
}

function Thumb({ file, actions, large }: { file: LibraryRow; actions: FileActions; large?: boolean }) {
  const url = file.canPreview ? actions.previewUrl(file) : undefined;
  if (url) {
    // A plain <img>: the URL is a short-lived capability that next/image would
    // proxy and cache past its expiry.
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => actions.onPreviewError(file)}
        className="h-full w-full object-cover"
      />
    );
  }
  const Icon = KIND_ICON[file.kind];
  return <Icon className={large ? "h-10 w-10 text-primary/35" : "h-4 w-4 text-primary/50"} aria-hidden />;
}

function Meta({ file }: { file: LibraryRow }) {
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-primary/60">
      <span>{KIND_LABEL[file.kind]}</span>
      <span aria-hidden>·</span>
      <span>{fmtBytes(file.size)}</span>
      {file.source === "generated" && (
        <>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-0.5">
            <Sparkles className="h-3 w-3" aria-hidden /> Generated
          </span>
        </>
      )}
      <Status file={file} />
    </p>
  );
}

function Status({ file }: { file: LibraryRow }) {
  if (file.status === "processing") {
    return (
      <span className="inline-flex items-center gap-1" title={file.stageMessage ?? undefined}>
        <span aria-hidden>·</span>
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        {file.progress != null ? `Processing ${file.progress}%` : "Processing"}
      </span>
    );
  }
  if (file.status === "failed" && file.retryAt && !file.deadLettered) {
    // A transient failure: the server retries it on its own.
    return (
      <span className="inline-flex items-center gap-1" title={file.error ?? undefined}>
        <span aria-hidden>·</span>
        <RotateCcw className="h-3 w-3" aria-hidden /> Retrying automatically
      </span>
    );
  }
  if (file.status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-destructive" title={file.error ?? undefined}>
        <span aria-hidden>·</span>
        <AlertCircle className="h-3 w-3" aria-hidden /> Couldn't read
      </span>
    );
  }
  if (!file.hasBlob) {
    return <span title="The original is being restored">· Restoring</span>;
  }
  return null;
}

function FileMenu({ file, actions }: { file: LibraryRow; actions: FileActions }) {
  const chatReadable = file.kind !== "other" && file.hasBlob;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${file.name}`}
          className="shrink-0 rounded-md p-1.5 text-primary/60 transition hover:bg-primary/5 hover:text-primary [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      {/* Radix portals to <body>: re-enter the workspace palette. */}
      <DropdownMenuContent align="end" className="workspace w-48">
        <DropdownMenuItem onSelect={() => actions.onOpen(file)} disabled={!file.hasBlob}>
          <ExternalLink className="mr-2 h-4 w-4" /> Open
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onDownload(file)} disabled={!file.hasBlob}>
          <Download className="mr-2 h-4 w-4" /> Download
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.onRename(file)}>
          <Pencil className="mr-2 h-4 w-4" /> Rename
        </DropdownMenuItem>
        {chatReadable && (
          <DropdownMenuItem onSelect={() => actions.onAddToChat(file)}>
            <MessageSquarePlus className="mr-2 h-4 w-4" /> Add to chat
          </DropdownMenuItem>
        )}
        {file.status === "failed" && (
          <DropdownMenuItem onSelect={() => actions.onRetry(file)}>
            <RotateCcw className="mr-2 h-4 w-4" /> Retry
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => actions.onDelete(file)} className="text-destructive focus:text-destructive">
          <Trash2 className="mr-2 h-4 w-4" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
