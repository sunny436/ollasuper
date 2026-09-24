"use client";

import { accepted, sha256Hex } from "@/lib/knowledge-file";
import { InfiniteSentinel } from "@/components/infinite-sentinel";
import { storageContentType } from "@/lib/upload-content-type";

import { ConfirmButton } from "@/components/confirm-button";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import { useMutation, usePaginatedQuery } from "convex/react";
import { useRef, useState } from "react";
import { toast } from "sonner";

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function FilesPage() {
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
  // The SAME per-user knowledge base the chat rail and Settings > Files show.
  // This page used to list `files` only, so a file uploaded here (or in chat)
  // was invisible on the other surface. Listing both is what makes every door
  // show one collection; the queries are untouched, so each keeps its own scope
  // and nothing becomes visible to anyone who could not already see it.
  const {
    results: knowledge,
    status: knowledgeStatus,
    loadMore: loadMoreKnowledge,
  } = usePaginatedQuery(
    api.userFiles.list,
    current ? { workspaceId: current } : "skip",
    { initialNumItems: 20 },
  );
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const generateKnowledgeUploadUrl = useMutation(api.userFiles.generateUploadUrl);
  const saveFile = useMutation(api.files.saveFile);
  const saveKnowledgeFile = useMutation(api.userFiles.saveFile);
  const removeFile = useMutation(api.files.remove);
  const removeKnowledge = useMutation(api.userFiles.remove);
  const retryKnowledge = useMutation(api.userFiles.retry);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !current) return;
    // Server is authoritative (pipeline rejects > ai_max_attachment_bytes), but
    // refuse oversize here too so the user gets an instant, clear notification
    // instead of a full upload that then fails. Mirrors use-attachments.ts.
    const MAX_BYTES = 20 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      toast.error(`File too large: ${mb} MB (maximum 20 MB)`);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setBusy(true);
    try {
      // WHICH FILE decides, never which page. A file the ingest pipeline can
      // read becomes a searchable knowledge file exactly as it would from the
      // chat paperclip; anything else keeps this page's original behaviour and
      // is stored as a plain workspace file. See lib/knowledge-file.ts.
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

  return (
    <div className="flex h-full w-full bg-secondary px-6 py-8 dark:bg-black">
      <div className="z-10 mx-auto w-full max-w-screen-xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-medium text-primary">Files</h1>
            <p className="text-sm text-primary/60">
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
              className={`inline-flex h-9 items-center rounded-md border border-border bg-card px-4 text-sm ${
                busy ? "opacity-60" : ""
              }`}
            >
              {busy ? "Uploading…" : "Upload file"}
            </span>
          </label>
        </div>

        {/* Searchable — the same per-user knowledge base as the chat rail. */}
        <div className="mb-6 overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium text-primary/85">Searchable</h2>
            <span className="rounded-full bg-primary/5 px-2 py-0.5 text-[11px] text-primary/65">
              {knowledge.length}
            </span>
            <span className="ml-auto text-xs text-primary/65">
              Used to answer your questions in chat · only you can see these
            </span>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {knowledgeStatus === "LoadingFirstPage" && (
                <tr>
                  <td className="px-4 py-6 text-primary/60" colSpan={4}>
                    Loading…
                  </td>
                </tr>
              )}
              {knowledgeStatus !== "LoadingFirstPage" &&
                knowledge.length === 0 && (
                  <tr>
                    <td className="px-4 py-6 text-primary/60" colSpan={4}>
                      Nothing searchable yet — upload a document, spreadsheet,
                      image or code file.
                    </td>
                  </tr>
                )}
              {knowledge.map((f) => (
                <tr
                  key={f._id}
                  className="border-b border-border/50 last:border-0"
                >
                  <td className="px-4 py-3 text-primary/80">{f.name}</td>
                  <td className="px-4 py-3 text-primary/60">{fmtSize(f.size)}</td>
                  <td className="px-4 py-3 text-primary/65">
                    {f.status === "ready"
                      ? "Ready"
                      : f.status === "processing"
                        ? "Processing…"
                        : `Failed${f.error ? ` — ${f.error}` : ""}`}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {f.status === "failed" && (
                      <button
                        type="button"
                        className="mr-2 rounded-md px-2 py-1 text-xs text-primary/70 transition hover:bg-primary/5"
                        onClick={async () => {
                          await retryKnowledge({ fileId: f._id });
                          toast.success("Retrying");
                        }}
                      >
                        Retry
                      </button>
                    )}
                    <ConfirmButton
                      label="delete"
                      title="Delete file?"
                      description={f.name}
                      confirmLabel="Delete"
                      onConfirm={async () => {
                        await removeKnowledge({ fileId: f._id });
                        toast.success("File deleted");
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <InfiniteSentinel
            status={knowledgeStatus}
            loadMore={loadMoreKnowledge}
            pageSize={20}
          />
        </div>

        {/* Stored only — types the ingest pipeline cannot read (.zip, video…). */}
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <h2 className="text-sm font-medium text-primary/85">Stored</h2>
            <span className="rounded-full bg-primary/5 px-2 py-0.5 text-[11px] text-primary/65">
              {files.length}
            </span>
            <span className="ml-auto text-xs text-primary/65">
              Not searchable · visible to your workspace
            </span>
          </div>
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-primary/60">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Size</th>
                <th className="px-4 py-3 font-medium">Uploaded</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {status === "LoadingFirstPage" && (
                <tr>
                  <td className="px-4 py-6 text-primary/60" colSpan={4}>
                    Loading…
                  </td>
                </tr>
              )}
              {status !== "LoadingFirstPage" && files.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-primary/60" colSpan={4}>
                    No stored files.
                  </td>
                </tr>
              )}
              {files.map((f) => (
                <tr
                  key={f._id}
                  className="border-b border-border/50 last:border-0"
                >
                  <td className="px-4 py-3">
                    {f.url ? (
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary/80 underline"
                      >
                        {f.name}
                      </a>
                    ) : (
                      <span className="text-primary/80">{f.name}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-primary/60">{fmtSize(f.size)}</td>
                  <td className="px-4 py-3 text-primary/65">
                    {new Date(f.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ConfirmButton
                      label="delete"
                      title="Delete file?"
                      description={f.name}
                      confirmLabel="Delete"
                      onConfirm={async () => {
                        await removeFile({ fileId: f._id });
                        toast.success("File deleted");
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <InfiniteSentinel status={status} loadMore={loadMore} pageSize={20} />
      </div>
    </div>
  );
}
