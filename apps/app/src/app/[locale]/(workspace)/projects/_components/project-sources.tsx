"use client";

import { storageContentType } from "@/lib/upload-content-type";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation, usePaginatedQuery } from "convex/react";
import {
  AlertCircle,
  FileText,
  FolderMinus,
  Loader2,
  Upload,
  Paperclip,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "../../chat/_hooks/use-modal-focus";
import { toast } from "sonner";
import { fmtSize } from "../../chat/_lib/format";

/**
 * A Project's sources — the files its chats can retrieve from.
 *
 * Reuses the account file pipeline as-is (`userFiles.generateUploadUrl` +
 * `saveFile`, which dispatches ingestion): there is exactly one parser, chunker,
 * embedder and vector store, and a Project is a membership edge over it, never a
 * second pipeline.
 *
 * Both entry points converge on `projects.linkFile`:
 *   • Upload — save the file, then link it.
 *   • Attach — link a file the account already has.
 * That convergence is what makes DEDUP coherent. Re-uploading a file you already
 * own returns the EXISTING userFiles row, so without the link step the upload
 * would appear to do nothing at all.
 *
 * Nothing here is a security boundary: the list comes from an authorized query
 * and every mutation re-authorizes both the Project and the file server-side.
 */

const PAGE = 20;

export function ProjectSources({
  projectId,
  workspaceId,
  archived,
}: {
  projectId: Id<"projects">;
  workspaceId: Id<"workspaces"> | null;
  archived: boolean;
}) {
  const generateUploadUrl = useMutation(api.userFiles.generateUploadUrl);
  const saveFile = useMutation(api.userFiles.saveFile);
  const linkFile = useMutation(api.projects.linkFile);
  const unlinkFile = useMutation(api.projects.unlinkFile);

  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { results, status, loadMore } = usePaginatedQuery(
    api.projects.listFiles,
    { projectId },
    { initialNumItems: PAGE },
  );

  const onUpload = async (file: File) => {
    if (!workspaceId) return;
    setUploading(true);
    try {
      const url = await generateUploadUrl({ workspaceId });
      const res = await fetch(url, {
        method: "POST",
        headers: {
          // A code file can have an EMPTY browser MIME, which Convex storage
          // rejects with a 400.
          "Content-Type": storageContentType(file.type),
        },
        body: file,
      });
      if (!res.ok) throw new Error(`upload failed (${res.status})`);
      const { storageId } = await res.json();

      // Per-user dedup + idempotency key, same hash the account path uses.
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await file.arrayBuffer(),
      );
      const contentHash = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");

      const fileId = await saveFile({
        workspaceId,
        storageId: storageId as Id<"_storage">,
        name: file.name,
        size: file.size,
        contentType: file.type || "application/octet-stream",
        contentHash,
      });
      // Load-bearing: on a deduped upload saveFile returns the pre-existing row
      // and starts no new ingestion, so this link is the only thing that
      // actually adds the file to the Project.
      await linkFile({ projectId, fileId });
      toast.success(`Added ${file.name}`);
    } catch (e) {
      // Never console.error — the Convex client already logs rejections and
      // every e2e script asserts zero console errors.
      toast.error(
        e instanceof Error && e.message
          ? cleanError(e.message)
          : "Couldn't add that file",
      );
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const onUnlink = async (fileId: Id<"userFiles">, name: string) => {
    try {
      await unlinkFile({ projectId, fileId });
      toast.success(`Removed ${name} from this project`);
    } catch {
      toast.error("Couldn't remove that file");
    }
  };

  return (
    <section className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Chats in this project answer from these files only.
        </p>
        {!archived && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              disabled={!workspaceId}
              className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-primary disabled:opacity-40"
            >
              <Paperclip className="h-3.5 w-3.5" /> Attach existing
            </button>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading || !workspaceId}
              className="flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-sm transition hover:brightness-110 disabled:opacity-40"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              {uploading ? "Uploading…" : "Add file"}
            </button>
          </div>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onUpload(f);
        }}
      />

      {status === "LoadingFirstPage" && (
        <div className="mt-3 space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-primary/5" />
          ))}
        </div>
      )}

      {status !== "LoadingFirstPage" && results.length === 0 && (
        <div className="mt-4 rounded-2xl border border-dashed border-border px-6 py-14 text-center">
          <div className="flex items-center justify-center gap-2">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/5 text-muted-foreground">
              <FileText className="h-4 w-4" />
            </span>
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand-ink">
              <Upload className="h-4 w-4" />
            </span>
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-primary/5 text-muted-foreground">
              <Paperclip className="h-4 w-4" />
            </span>
          </div>
          <p className="mt-4 text-sm font-medium text-primary">
            Give this project more context
          </p>
          {/* Deliberately describes only what exists. The reference offers Slack
              and Drive connectors here; naming them would promise an integration
              this product does not have. */}
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Upload a file, or attach one you have already added, and this
            project's chats can answer from it.
          </p>
          {!archived && (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading || !workspaceId}
              className="mt-5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-sm transition hover:brightness-110 disabled:opacity-40"
            >
              {uploading ? "Uploading…" : "Add sources"}
            </button>
          )}
        </div>
      )}

      {results.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {results.map((f) => (
            <li
              key={f._id}
              className="group flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/5 text-primary/65">
                {f.status === "processing" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : f.status === "failed" ? (
                  <AlertCircle className="h-4 w-4 text-destructive" />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-primary">
                  {f.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {f.status === "processing"
                    ? (f.stage ?? "Processing…")
                    : f.status === "failed"
                      ? (f.error ?? "Couldn't be processed")
                      : fmtSize(f.size)}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${f.name} from project`}
                title="Removes it from this project. The file itself is kept."
                onClick={() => void onUnlink(f._id, f.name)}
                className="shrink-0 rounded p-1 text-primary/30 opacity-0 transition hover:bg-primary/10 hover:text-primary/70 focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
              >
                <FolderMinus className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {status === "CanLoadMore" && (
        <button
          type="button"
          onClick={() => loadMore(PAGE)}
          className="mt-2 w-full rounded-md px-2 py-1.5 text-xs text-primary/65 transition hover:bg-primary/5"
        >
          Load more
        </button>
      )}

      {pickerOpen && workspaceId && (
        <AttachExistingDialog
          projectId={projectId}
          workspaceId={workspaceId}
          alreadyLinked={new Set(results.map((f) => f._id as string))}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  );
}

/**
 * Pick a file the account already has.
 *
 * Necessary because uploads dedup: a file you have uploaded before cannot be
 * "re-uploaded" into a Project, so without this there would be no way to put it
 * in one.
 */
function AttachExistingDialog({
  projectId,
  workspaceId,
  alreadyLinked,
  onClose,
}: {
  projectId: Id<"projects">;
  workspaceId: Id<"workspaces">;
  alreadyLinked: Set<string>;
  onClose: () => void;
}) {
  const linkFile = useMutation(api.projects.linkFile);
  const [busy, setBusy] = useState(false);
  // Mounted only while open. It had no Escape handler at all.
  const dialogRef = useModalFocus<HTMLDivElement>(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const { results, status, loadMore } = usePaginatedQuery(
    api.userFiles.list,
    { workspaceId },
    { initialNumItems: PAGE },
  );

  const attach = async (fileId: Id<"userFiles">, name: string) => {
    setBusy(true);
    try {
      await linkFile({ projectId, fileId });
      toast.success(`Added ${name}`);
      onClose();
    } catch (e) {
      toast.error(
        e instanceof Error && e.message
          ? cleanError(e.message)
          : "Couldn't add that file",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-away dismiss */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Attach an existing file"
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[70vh] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-card p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-primary">Attach a file</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-accent hover:text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="scrollbar-quiet mt-4 min-h-0 flex-1 overflow-y-auto">
          {status === "LoadingFirstPage" && (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-10 animate-pulse rounded-lg bg-primary/5"
                />
              ))}
            </div>
          )}
          {status !== "LoadingFirstPage" && results.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No files yet. Upload one instead.
            </p>
          )}
          <ul className="space-y-1">
            {results.map((f) => {
              const linked = alreadyLinked.has(f._id as string);
              return (
                <li key={f._id}>
                  <button
                    type="button"
                    disabled={busy || linked}
                    onClick={() => void attach(f._id, f.name)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-primary disabled:opacity-50"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{f.name}</span>
                    {linked && (
                      <span className="ml-auto shrink-0 text-[11px]">Added</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {status === "CanLoadMore" && (
            <button
              type="button"
              onClick={() => loadMore(PAGE)}
              className="mt-2 w-full rounded-md px-2 py-1.5 text-xs text-primary/65 transition hover:bg-primary/5"
            >
              Load more
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** Convex wraps thrown ConvexErrors with framing noise; show just the message. */
function cleanError(raw: string): string {
  const m = /Uncaught ConvexError:\s*(.+?)(\n|$)/.exec(raw);
  if (m?.[1]) return m[1];
  return raw.split("\n")[0]?.slice(0, 160) ?? "Couldn't add that file";
}
