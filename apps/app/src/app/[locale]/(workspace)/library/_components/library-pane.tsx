"use client";

import { FreeUpSpaceDialog } from "@/components/library/free-up-space-dialog";
import { LibraryUploadDialogs } from "@/components/library/upload-dialogs";
import { libraryErrorMessage, useLibraryUpload } from "@/components/library/use-library-upload";
import { InfiniteSentinel } from "@/components/infinite-sentinel";
import { libraryFileUrl } from "@/lib/library";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, usePaginatedQuery } from "convex/react";
import { LayoutGrid, List, PanelLeft, Search, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { NotificationsBell } from "../../../(dashboard)/_components/notifications-bell";
import { useChatSidebar } from "../../chat/_components/chat-shell";
import { ConfirmDialog } from "../../scheduled/_components/confirm-dialog";
import { FileCard, type FileActions, FileListRow, type LibraryRow } from "./library-file";
import { RenameDialog } from "./rename-dialog";
import { StorageMeter } from "./storage-meter";
import { usePreviews } from "./use-previews";

const PAGE = 30;
const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";

type Kind = LibraryRow["kind"];
type Sort = "newest" | "oldest" | "name_asc" | "name_desc";

const KINDS: { value: Kind | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "image", label: "Images" },
  { value: "pdf", label: "PDFs" },
  { value: "document", label: "Documents" },
  { value: "spreadsheet", label: "Spreadsheets" },
  { value: "presentation", label: "Presentations" },
  { value: "text", label: "Text & code" },
  { value: "other", label: "Other" },
];

const SORTS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "name_asc", label: "Name A–Z" },
  { value: "name_desc", label: "Name Z–A" },
];

/** The server's reason for refusing a retry, in words (userFiles.retry). */
const RETRY_REFUSED: Record<string, string> = {
  retry_limit: "You've retried this file 3 times today. Try again tomorrow.",
  rate_limited: "Too many retries just now. Wait a few minutes.",
  needs_reupload: "This file's original is gone. Upload it again.",
  not_failed: "This file is no longer in a failed state.",
};

const selectCls =
  "rounded-full border border-border bg-card px-3 py-2 text-sm text-primary outline-none transition focus:border-brand";

/**
 * The File Library. Every filter, sort and name search runs on the SERVER
 * (library.list) — the page never filters rows it was given, because hiding a
 * row in React is not access control and a client filter over one page would
 * answer "no matches" for the 31st file.
 */
export function LibraryPane() {
  const { current } = useWorkspace();
  const router = useRouter();
  const { openSidebar, collapsed, toggleCollapsed } = useChatSidebar();
  const [kind, setKind] = useState<Kind | "all">("all");
  const [source, setSource] = useState<"all" | "uploaded" | "generated">("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<LibraryRow | null>(null);
  const [deleting, setDeleting] = useState<LibraryRow | null>(null);
  const [freeUpOpen, setFreeUpOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Name search is debounced so each keystroke is not a new subscription.
  useEffect(() => {
    const t = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { results, status, loadMore } = usePaginatedQuery(
    api.library.list,
    current
      ? {
          workspaceId: current,
          sort,
          ...(kind !== "all" ? { kind } : {}),
          ...(source !== "all" ? { source } : {}),
          ...(search ? { search } : {}),
        }
      : "skip",
    { initialNumItems: PAGE },
  );
  const files = results as LibraryRow[];

  const previewIds = useMemo(() => files.filter((f) => f.canPreview).map((f) => f._id), [files]);
  const previews = usePreviews(previewIds);
  const { upload, dialogs } = useLibraryUpload(current ?? null);
  const mintAccess = useMutation(api.library.mintAccess);
  const rename = useMutation(api.library.rename);
  const removeFile = useMutation(api.userFiles.remove);
  const removeMany = useMutation(api.library.removeMany);
  const retry = useMutation(api.userFiles.retry);

  const uploadAll = async (list: File[]) => {
    for (const file of list) {
      setUploading((n) => n + 1);
      try {
        const r = await upload(file, { purpose: "library", offerReuse: false });
        if (r && "fileId" in r) toast.success(`Added ${file.name}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const openCapability = async (f: LibraryRow, purpose: "download" | "preview") => {
    // Opened synchronously, so the popup blocker sees the click, then pointed
    // at the capability once the server has minted it.
    const tab = purpose === "preview" ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    try {
      const { token } = await mintAccess({ fileId: f._id, purpose });
      const url = libraryFileUrl(CONVEX_URL, token, purpose);
      if (tab) {
        tab.location.href = url;
        return;
      }
      const a = document.createElement("a");
      a.href = url;
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      tab?.close();
      toast.error(libraryErrorMessage(e, "Couldn't open the file"));
    }
  };

  const actions: FileActions = {
    // Only a verified raster image is ever shown in the browser; everything
    // else is downloaded (the server enforces this too).
    onOpen: (f) => void openCapability(f, f.canPreview ? "preview" : "download"),
    onDownload: (f) => void openCapability(f, "download"),
    onRename: (f) => setRenaming(f),
    onAddToChat: (f) => router.push(`/chat?attach=${f._id}`),
    onDelete: (f) => setDeleting(f),
    onRetry: async (f) => {
      try {
        const r = await retry({ fileId: f._id });
        if (r?.ok) toast.success("Retrying…");
        else toast.error(RETRY_REFUSED[r?.reason ?? ""] ?? "Couldn't retry — try again later");
      } catch (e) {
        toast.error(libraryErrorMessage(e, "Couldn't retry"));
      }
    },
    previewUrl: (f) => previews.urlOf(f._id),
    onPreviewError: (f) => previews.onError(f._id),
  };

  const loading = status === "LoadingFirstPage";
  const filtered = kind !== "all" || source !== "all" || search !== "";

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void uploadAll(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="scrollbar-quiet flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="flex shrink-0 items-center gap-1 px-3 py-3">
          <button
            type="button"
            onClick={openSidebar}
            aria-label="Open conversations"
            className="rounded-md p-1.5 text-primary/65 hover:bg-primary/5 hover:text-primary md:hidden [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          {/* Only while collapsed: the open rail carries its own toggle. */}
          {collapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Show conversations"
              data-rail-opener=""
              className="hidden rounded-md p-1.5 text-primary/65 hover:bg-primary/5 hover:text-primary md:block"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
          )}
          <div className="ml-auto">
            <NotificationsBell />
          </div>
        </div>

        <div className="mx-auto w-full max-w-5xl px-5 pb-24">
          <header className="flex flex-wrap items-end justify-between gap-4 pt-6">
            <div className="flex min-w-0 flex-col gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-primary">Library</h1>
              <StorageMeter onFreeUp={() => setFreeUpOpen(true)} />
            </div>
            <div>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const list = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  void uploadAll(list);
                }}
              />
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={!current}
                className="flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition hover:opacity-90 active:scale-95 disabled:bg-muted disabled:text-muted-foreground"
              >
                <Upload className="h-4 w-4" />
                {uploading > 0 ? `Uploading ${uploading}…` : "Upload"}
              </button>
            </div>
          </header>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[12rem] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search file names"
                aria-label="Search file names"
                className="w-full rounded-full border border-border bg-card py-2 pl-9 pr-3 text-base text-primary outline-none transition placeholder:text-muted-foreground focus:border-brand md:text-sm"
              />
            </div>
            <select aria-label="File type" value={kind} onChange={(e) => setKind(e.target.value as Kind | "all")} className={selectCls}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <select
              aria-label="Source"
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
              className={selectCls}
            >
              <option value="all">All files</option>
              <option value="uploaded">Uploaded</option>
              <option value="generated">Generated</option>
            </select>
            <select
              aria-label="Sort"
              value={sort}
              disabled={search !== ""}
              title={search ? "Search results are ordered by relevance" : undefined}
              onChange={(e) => setSort(e.target.value as Sort)}
              className={`${selectCls} disabled:opacity-50`}
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <div className="flex rounded-full border border-border p-0.5" role="group" aria-label="View">
              {(["grid", "list"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  aria-label={v === "grid" ? "Grid view" : "List view"}
                  onClick={() => setView(v)}
                  className={`rounded-full p-1.5 transition ${view === v ? "bg-primary/10 text-primary" : "text-primary/60 hover:text-primary"}`}
                >
                  {v === "grid" ? <LayoutGrid className="h-4 w-4" /> : <List className="h-4 w-4" />}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6">
            {loading ? (
              <p className="py-16 text-center text-sm text-primary/60">Loading your files…</p>
            ) : files.length === 0 ? (
              <EmptyState filtered={filtered} onUpload={() => fileInput.current?.click()} />
            ) : view === "grid" ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {files.map((f) => (
                  <FileCard key={f._id} file={f} actions={actions} />
                ))}
              </div>
            ) : (
              <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border bg-card">
                {files.map((f) => (
                  <FileListRow key={f._id} file={f} actions={actions} />
                ))}
              </div>
            )}
            <InfiniteSentinel status={status} loadMore={loadMore} pageSize={PAGE} className="py-6" />
          </div>
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-3xl border-2 border-dashed border-brand bg-background/90 text-sm font-medium text-primary">
          Drop to add to your Library
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete file?"
        body={`${deleting?.name ?? ""} will be removed from your Library and from any chat it is attached to.`}
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await removeFile({ fileId: deleting._id });
            toast.success("Deleted");
          } catch (e) {
            toast.error(libraryErrorMessage(e, "Couldn't delete the file"));
          }
        }}
      />
      <RenameDialog
        name={renaming?.name ?? null}
        onClose={() => setRenaming(null)}
        onSave={async (next) => {
          if (!renaming) return;
          try {
            await rename({ fileId: renaming._id, name: next });
            toast.success("Renamed");
          } catch (e) {
            toast.error(libraryErrorMessage(e, "Couldn't rename"));
          }
        }}
      />
      <FreeUpSpaceDialog
        open={freeUpOpen}
        onOpenChange={setFreeUpOpen}
        onConfirm={async (ids: Id<"userFiles">[]) => {
          try {
            const r = await removeMany({ fileIds: ids });
            toast.success(`Deleted ${r.removed} file${r.removed === 1 ? "" : "s"}`);
          } catch (e) {
            toast.error(libraryErrorMessage(e, "Couldn't delete"));
          }
        }}
      />
      <LibraryUploadDialogs {...dialogs} />
    </div>
  );
}

function EmptyState({ filtered, onUpload }: { filtered: boolean; onUpload: () => void }) {
  if (filtered) {
    return <p className="py-16 text-center text-sm text-primary/60">No files match.</p>;
  }
  return (
    <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-border px-6 py-16 text-center">
      <p className="text-base font-medium text-primary">Your Library is empty</p>
      <p className="max-w-sm text-sm text-primary/60">
        Files you upload — here or in a chat — and files the assistant makes for you are kept here, private to you.
      </p>
      <button
        type="button"
        onClick={onUpload}
        className="mt-2 rounded-full border border-border px-4 py-2 text-sm text-primary transition hover:bg-accent"
      >
        Upload a file
      </button>
    </div>
  );
}
