"use client";

import { storageContentType } from "@/lib/upload-content-type";

import { accepted, sha256Hex } from "@/lib/knowledge-file";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

export interface PendingAttachment {
  localId: string;
  name: string;
  size: number;
  contentType: string;
  isImage: boolean;
  previewUrl: string | null;
  progress: number;
  /**
   * The CLIENT's view of the upload, and the only thing that gates Send.
   *
   * `ready` means `register()` returned an id — NOT that any server-side
   * processing finished, because a chat attachment has none: register writes
   * `status: "uploaded"` and nothing ever advances it, and the text/image
   * extraction happens at generation time in the Python plane. The
   * processing/ingesting lifecycle belongs to the separate `userFiles` record
   * the Option-B copy below creates, which is what the sidebar badge shows.
   * Those two are deliberately independent; do not gate sending on the latter.
   */
  status: "uploading" | "ready" | "error";
  attachmentId: Id<"chatAttachments"> | null;
  // The persistent account-knowledge file this attachment also became (Option B:
  // a separate upload). Lets chip removal drop the knowledge file too.
  userFileId: Id<"userFiles"> | null;
  /**
   * Kept so a failed upload can be RETRIED in place.
   *
   * Without it there is nothing to re-send: the File used to exist only as a
   * closure argument to upload(), so a failure was a dead end — the chip could
   * only be removed and the file picked again. A File is a lazy handle to disk,
   * not a copy in memory, and an image already pins one through
   * URL.createObjectURL, so holding it costs effectively nothing.
   */
  file: File;
}

const MAX_FILES = 6;
const MAX_BYTES = 20 * 1024 * 1024;

export function useAttachments(threadId: string | null) {
  const { current } = useWorkspace();
  const generateUploadUrl = useMutation(api.chat.attachments.generateUploadUrl);
  const register = useMutation(api.chat.attachments.register);
  const removeAttachment = useMutation(api.chat.attachments.remove);
  // Persistent account-knowledge (reused as-is; see Option B in use-attachments).
  const saveKnowledgeFile = useMutation(api.userFiles.saveFile);
  const removeKnowledgeFile = useMutation(api.userFiles.remove);
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const counter = useRef(0);
  /**
   * Chips removed while their upload was still in flight.
   *
   * Nothing cancels an XHR that is already running, so removing a chip mid-
   * upload used to leave the request to finish unattended: `register()` still
   * created a chatAttachments row and a blob, and the Option-B copy still
   * created a userFiles row that then appeared in the sidebar for a file the
   * user had just cancelled. `remove()` could not clean either up because the
   * ids did not exist yet when it ran.
   *
   * Nothing collects those afterwards either — no cron touches chatAttachments,
   * and the only sweep is thread deletion, which cannot reach a row whose
   * threadId is undefined (every attachment started from the empty state).
   *
   * So cancellation is recorded here instead, and whoever learns an id first is
   * responsible for deleting it. A ref, not state: the upload path must see the
   * CURRENT value when its await resolves, not the value captured at render.
   */
  const cancelled = useRef<Set<string>>(new Set());
  /**
   * Retries already running, keyed by localId.
   *
   * `retry` gates on `status === "error"`, but two clicks landing before
   * React commits the re-render would both read the stale `error` and start
   * two uploads for one chip — two registrations, and the first row orphaned
   * the moment the second overwrote its id. A ref settles it synchronously;
   * state cannot, because that is the very thing that has not updated yet.
   */
  const retrying = useRef<Set<string>>(new Set());

  const patch = useCallback(
    (localId: string, next: Partial<PendingAttachment>) => {
      setItems((prev) =>
        prev.map((i) => (i.localId === localId ? { ...i, ...next } : i)),
      );
    },
    [],
  );

  const upload = useCallback(
    async (file: File, localId: string) => {
      if (!current) return;
      try {
        const url = await generateUploadUrl({ workspaceId: current });

        // XMLHttpRequest, not fetch: fetch exposes NO upload progress, and the
        // chips need a real percentage rather than an indeterminate spinner.
        const storageId = await new Promise<string>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", url);
          // Code files (.py, …) can have an EMPTY browser MIME, which Convex
          // storage rejects with a 400. Fall back so the upload always has a
          // valid content-type (register/classify handle the real kind).
          xhr.setRequestHeader("Content-Type", storageContentType(file.type));
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              patch(localId, {
                progress: Math.round((e.loaded / e.total) * 100),
              });
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText).storageId);
              } catch {
                reject(new Error("bad upload response"));
              }
            } else {
              reject(new Error(`upload failed (${xhr.status})`));
            }
          };
          xhr.onerror = () => reject(new Error("upload failed"));
          xhr.send(file);
        });

        const attachmentId = await register({
          workspaceId: current,
          storageId: storageId as Id<"_storage">,
          name: file.name,
          size: file.size,
          // The SAME neutralised type the blob was stored under. register()
          // refuses an executable declared type, and browsers declare .xml as
          // text/xml (audit F-02 made that executable) — the row still
          // classifies as text by extension, and the bytes are unchanged.
          contentType: storageContentType(file.type),
          ...(threadId ? { threadId: threadId as Id<"chatThreads"> } : {}),
        });

        // The chip may have been removed while this upload was in flight. The
        // row and blob exist now, and nothing else will ever collect them, so
        // undo the registration here and stop before the knowledge copy.
        if (cancelled.current.has(localId)) {
          cancelled.current.delete(localId);
          await removeAttachment({ attachmentId }).catch(() => {});
          return;
        }

        patch(localId, { status: "ready", progress: 100, attachmentId });

        // Option B: ALSO persist this file as account-level knowledge via a
        // SEPARATE upload (independent blob, so the RAG backend stays untouched
        // and there is no lifecycle coupling to the chat attachment). Runs in
        // the background — a failure here must never break the attachment/send.
        void (async () => {
          try {
            const contentType = file.type || "application/octet-stream";
            const contentHash = await sha256Hex(file);
            const kUrl = await generateUploadUrl({ workspaceId: current });
            const kRes = await fetch(kUrl, {
              method: "POST",
              // Stored under a type no browser executes, like the attachment
              // above; the declared type still reaches the row below.
              headers: { "content-type": storageContentType(contentType) },
              body: file,
            });
            const { storageId: kStorageId } = await kRes.json();
            const userFileId = await saveKnowledgeFile({
              workspaceId: current,
              storageId: kStorageId as Id<"_storage">,
              name: file.name,
              size: file.size,
              contentType,
              contentHash,
            });
            // Cancelled while this copy was uploading. Without this the file
            // reappears in the sidebar knowledge base moments after the user
            // removed it from the composer — the most visible symptom of the
            // whole race.
            if (cancelled.current.has(localId)) {
              await removeKnowledgeFile({ fileId: userFileId }).catch(() => {});
              return;
            }
            patch(localId, { userFileId });
          } catch {
            // Best-effort — the chat attachment already works without this.
          }
        })();
      } catch {
        // A cancelled upload that then fails needs no chip update and no toast:
        // the user already removed it and does not care that it failed.
        if (cancelled.current.has(localId)) {
          cancelled.current.delete(localId);
          return;
        }
        patch(localId, { status: "error" });
        toast.error(`Couldn't upload ${file.name}`);
      }
    },
    [
      current,
      generateUploadUrl,
      register,
      removeAttachment,
      removeKnowledgeFile,
      saveKnowledgeFile,
      threadId,
      patch,
    ],
  );

  const add = useCallback(
    (files: File[]) => {
      if (!current) return;
      const room = MAX_FILES - items.length;
      if (room <= 0) {
        toast.error(`At most ${MAX_FILES} attachments per message`);
        return;
      }
      for (const file of files.slice(0, room)) {
        if (file.size > MAX_BYTES) {
          toast.error(`${file.name} is larger than 20MB`);
          continue;
        }
        if (!accepted(file)) {
          toast.error(`${file.name}: unsupported file type`);
          continue;
        }
        counter.current += 1;
        const localId = `a${counter.current}`;
        const isImage = file.type.startsWith("image/");
        setItems((prev) => [
          ...prev,
          {
            localId,
            name: file.name,
            size: file.size,
            contentType: file.type,
            isImage,
            previewUrl: isImage ? URL.createObjectURL(file) : null,
            progress: 0,
            status: "uploading",
            attachmentId: null,
            userFileId: null,
            file,
          },
        ]);
        void upload(file, localId);
      }
    },
    [current, items.length, upload],
  );

  const remove = useCallback(
    async (localId: string) => {
      const item = items.find((i) => i.localId === localId);
      setItems((prev) => prev.filter((i) => i.localId !== localId));
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      // Still uploading: there is no id to delete yet, and the request will
      // not stop. Record it so whichever await resolves first cleans up.
      if (item && item.status === "uploading") {
        cancelled.current.add(localId);
      }
      if (item?.attachmentId) {
        try {
          await removeAttachment({ attachmentId: item.attachmentId });
        } catch {
          // The row is orphaned but harmless — it is never bound to a message
          // and the thread purge will collect it.
        }
      }
      // Removing a chip before send also drops the knowledge file it created,
      // so a discarded attachment doesn't linger permanently in the sidebar.
      if (item?.userFileId) {
        try {
          await removeKnowledgeFile({ fileId: item.userFileId });
        } catch {
          // Best-effort; a stray processing row is harmless.
        }
      }
    },
    [items, removeAttachment, removeKnowledgeFile],
  );

  /** Re-upload a failed attachment in place, reusing the retained File. */
  const retry = useCallback(
    (localId: string) => {
      const item = items.find((i) => i.localId === localId);
      if (!item || item.status !== "error") return;
      if (retrying.current.has(localId)) return;
      retrying.current.add(localId);
      // A retry that lands after the chip was removed must not resurrect it,
      // and a stale cancellation must not kill this fresh attempt.
      cancelled.current.delete(localId);
      patch(localId, { status: "uploading", progress: 0 });
      void upload(item.file, localId).finally(() => {
        retrying.current.delete(localId);
      });
    },
    [items, patch, upload],
  );

  const clear = useCallback(() => {
    for (const i of items) {
      if (i.previewUrl) URL.revokeObjectURL(i.previewUrl);
    }
    setItems([]);
  }, [items]);

  const readyIds = items
    .filter((i) => i.status === "ready" && i.attachmentId)
    .map((i) => i.attachmentId as Id<"chatAttachments">);

  return {
    items,
    add,
    remove,
    retry,
    clear,
    readyIds,
    uploading: items.some((i) => i.status === "uploading"),
    // Names, not a count: the composer refuses a send that would quietly drop
    // an attachment, and it has to be able to say WHICH one.
    failed: items.filter((i) => i.status === "error").map((i) => i.name),
  };
}
