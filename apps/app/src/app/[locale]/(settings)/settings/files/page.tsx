"use client";

import { accepted, sha256Hex } from "@/lib/knowledge-file";
import { storageContentType } from "@/lib/upload-content-type";

import { ConfirmButton } from "@/components/confirm-button";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import { Button } from "@v1/ui/button";
import { useMutation, usePaginatedQuery } from "convex/react";
import { FileText, ImageIcon, Braces, File as FileIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Category = "Images" | "Documents" | "Data & code" | "Other";
const ORDER: Category[] = ["Documents", "Images", "Data & code", "Other"];
const ICON: Record<Category, typeof FileIcon> = {
  Documents: FileText,
  Images: ImageIcon,
  "Data & code": Braces,
  Other: FileIcon,
};

function categoryOf(ct: string): Category {
  const c = (ct || "").toLowerCase();
  if (c.startsWith("image/")) return "Images";
  if (
    c === "application/pdf" ||
    c === "text/plain" ||
    c.includes("word") ||
    c.includes("document") ||
    c.includes("presentation") ||
    c.includes("sheet") ||
    c.includes("excel") ||
    c.includes("powerpoint") ||
    c.includes("rtf")
  )
    return "Documents";
  if (
    c === "application/json" ||
    c === "text/csv" ||
    c === "text/markdown" ||
    c.includes("javascript") ||
    c.includes("typescript") ||
    c.includes("xml") ||
    c.includes("yaml") ||
    c.startsWith("text/x-") ||
    c.startsWith("application/x-")
  )
    return "Data & code";
  return "Other";
}

export default function FilesSection() {
  const { current } = useWorkspace();
  const {
    results: files,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.files.listPaged,
    current ? { workspaceId: current } : "skip",
    { initialNumItems: 20 },
  );
  // THE SEARCHABLE HALF. The chat rail's "Files" is a DIFFERENT table:
  // `userFiles` is the per-user knowledge base (ingested + embedded, pinned to
  // the caller's own userId), while `files` above is workspace-scoped storage
  // any member can see. Both were labelled "Files", so the rail could say
  // "1 file - Ready" while this page said "No files yet" and neither was wrong.
  // Listing both here, clearly separated, is what makes the two consistent.
  // The queries stay untouched, so each keeps its own scope and nothing becomes
  // visible to anyone who could not already see it. Uploads on this page now
  // route by FILE TYPE into whichever of the two the file belongs in, so which
  // page you upload from no longer decides whether the model can read it.
  const {
    results: knowledge,
    status: knowledgeStatus,
    loadMore: loadMoreKnowledge,
  } = usePaginatedQuery(
    api.userFiles.list,
    current ? { workspaceId: current } : "skip",
    { initialNumItems: 20 },
  );
  const removeKnowledge = useMutation(api.userFiles.remove);
  const retryKnowledge = useMutation(api.userFiles.retry);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const generateKnowledgeUploadUrl = useMutation(
    api.userFiles.generateUploadUrl,
  );
  const saveFile = useMutation(api.files.saveFile);
  const saveKnowledgeFile = useMutation(api.userFiles.saveFile);
  const removeFile = useMutation(api.files.remove);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !current) return;
    // Mirror files/page.tsx + use-attachments.ts: refuse oversize client-side
    // for an instant, clear message (server is still authoritative).
    const MAX_BYTES = 20 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      toast.error(
        `File too large: ${(file.size / (1024 * 1024)).toFixed(1)} MB (maximum 20 MB)`,
      );
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setBusy(true);
    try {
      // WHICH FILE decides, never which page. A file the ingest pipeline can
      // read becomes a searchable knowledge file exactly as it would from the
      // chat paperclip; anything else is stored as a plain workspace file --
      // which is what this page did for everything. See lib/knowledge-file.ts.
      const searchable = accepted(file);
      const contentType = file.type || "application/octet-stream";
      const url = await (searchable
        ? generateKnowledgeUploadUrl({ workspaceId: current })
        : generateUploadUrl({ workspaceId: current }));
      const res = await fetch(url, {
        method: "POST",
        // Load-bearing: neuters text/html & svg so the blob is stored as a type
        // no browser will execute. Both saveFile guards judge the STORED type.
        headers: { "content-type": storageContentType(file.type) },
        body: file,
      });
      const { storageId } = await res.json();
      if (searchable) {
        await saveKnowledgeFile({
          workspaceId: current,
          storageId,
          name: file.name,
          size: file.size,
          contentType,
          contentHash: await sha256Hex(file),
        });
      } else {
        await saveFile({
          workspaceId: current,
          storageId,
          name: file.name,
          size: file.size,
          contentType,
        });
      }
      if (inputRef.current) inputRef.current.value = "";
      toast.success(`Uploaded ${file.name}`);
    } catch {
      toast.error("Upload failed");
    } finally {
      setBusy(false);
    }
  };

  // Group the loaded page by category. Only loaded files are grouped — "Load
  // more" pulls the next page in, so the categories fill as you page.
  const groups = new Map<Category, typeof files>();
  for (const f of files) {
    const cat = categoryOf(f.contentType);
    const arr = groups.get(cat);
    if (arr) arr.push(f);
    else groups.set(cat, [f]);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">
            Files
          </h1>
          <p className="mt-1 text-sm text-primary/65">
            Anything the assistant can read becomes searchable in chat.
            Everything else is stored as-is.
          </p>
        </div>
        <label className="cursor-pointer">
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            disabled={busy || !current}
            onChange={onUpload}
          />
          <span
            className={`inline-flex h-9 items-center rounded-lg border border-border bg-card px-4 text-sm text-primary transition hover:border-brand/30 ${
              busy ? "opacity-60" : ""
            }`}
          >
            {busy ? "Uploading…" : "Upload file"}
          </span>
        </label>
      </div>

      {status === "LoadingFirstPage" && (
        <p className="rounded-2xl border border-border bg-card/60 p-8 text-center text-sm text-primary/65 backdrop-blur-xl">
          Loading…
        </p>
      )}

      {status !== "LoadingFirstPage" && files.length === 0 && (
        <p className="rounded-2xl border border-border bg-card/60 p-8 text-center text-sm text-primary/65 backdrop-blur-xl">
          Nothing stored here — files the assistant can read are listed under
          Searchable below.
        </p>
      )}

      {ORDER.filter((cat) => groups.has(cat)).map((cat) => {
        const items = groups.get(cat) ?? [];
        const Icon = ICON[cat];
        return (
          <div
            key={cat}
            className="overflow-hidden rounded-2xl border border-border bg-card/60 backdrop-blur-xl"
          >
            <div className="flex items-center gap-2 border-b border-border px-5 py-3">
              <Icon className="h-4 w-4 text-primary/65" />
              <h2 className="text-sm font-medium text-primary/85">{cat}</h2>
              <span className="rounded-full bg-primary/5 px-2 py-0.5 text-[11px] text-primary/65">
                {items.length}
              </span>
            </div>
            <div className="divide-y divide-border/60">
              {items.map((f) => (
                <div
                  key={f._id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3"
                >
                  <div className="min-w-0 flex-1">
                    {f.url ? (
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-sm text-primary/85 underline-offset-2 hover:underline"
                      >
                        {f.name}
                      </a>
                    ) : (
                      <span className="truncate text-sm text-primary/85">
                        {f.name}
                      </span>
                    )}
                    <p className="mt-0.5 text-xs text-primary/60">
                      {fmtSize(f.size)} ·{" "}
                      {new Date(f.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <ConfirmButton
                    label="Delete"
                    title="Delete file?"
                    description={f.name}
                    confirmLabel="Delete"
                    className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-red-600 transition hover:bg-red-500/10 [@media(pointer:coarse)]:min-h-11"
                    onConfirm={async () => {
                      await removeFile({ fileId: f._id });
                      toast.success("File deleted");
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {status === "CanLoadMore" && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => loadMore(20)}>
            Load more
          </Button>
        </div>
      )}

      {/* Deliberately its own section, NOT folded into the type grouping above:
          these rows have a different owner and a different visibility rule, and
          merging them would misrepresent who can see what. They are also the
          only rows the model can actually read. */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card/60 backdrop-blur-xl">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <FileText className="h-4 w-4 text-primary/65" />
          <h2 className="text-sm font-medium text-primary/85">Searchable</h2>
          <span className="rounded-full bg-primary/5 px-2 py-0.5 text-[11px] text-primary/65">
            {knowledge.length}
          </span>
          <span className="ml-auto text-[11px] text-primary/60">
            Used to answer your questions in chat · only you can see these
          </span>
        </div>
        {knowledgeStatus === "LoadingFirstPage" ? (
          <p className="px-5 py-6 text-center text-sm text-primary/65">
            Loading…
          </p>
        ) : knowledge.length === 0 ? (
          <p className="px-5 py-6 text-center text-sm text-primary/65">
            Nothing searchable yet — upload a document, spreadsheet, image or
            code file above.
          </p>
        ) : (
          <div className="divide-y divide-border/60">
            {knowledge.map((f) => (
              <div
                key={f._id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <span className="truncate text-sm text-primary/85">
                    {f.name}
                  </span>
                  <p className="mt-0.5 text-xs text-primary/60">
                    {fmtSize(f.size)} ·{" "}
                    {new Date(f.createdAt).toLocaleDateString()} ·{" "}
                    {f.status === "ready"
                      ? "Ready"
                      : f.status === "processing"
                        ? "Processing…"
                        : "Failed"}
                  </p>
                </div>
                {f.status === "failed" && (
                  <button
                    type="button"
                    className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-primary/70 transition hover:bg-primary/5 [@media(pointer:coarse)]:min-h-11"
                    onClick={async () => {
                      await retryKnowledge({ fileId: f._id });
                      toast.success("Retrying");
                    }}
                  >
                    Retry
                  </button>
                )}
                <ConfirmButton
                  label="Delete"
                  title="Delete file?"
                  description={f.name}
                  confirmLabel="Delete"
                  className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-red-600 transition hover:bg-red-500/10 [@media(pointer:coarse)]:min-h-11"
                  onConfirm={async () => {
                    await removeKnowledge({ fileId: f._id });
                    toast.success("File deleted");
                  }}
                />
              </div>
            ))}
          </div>
        )}
        {knowledgeStatus === "CanLoadMore" && (
          <div className="flex justify-center border-t border-border py-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadMoreKnowledge(20)}
            >
              Load more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
