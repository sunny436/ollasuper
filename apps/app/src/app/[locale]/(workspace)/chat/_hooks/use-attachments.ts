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
  status: "uploading" | "ready" | "error";
  attachmentId: Id<"chatAttachments"> | null;
  // The persistent account-knowledge file this attachment also became (Option B:
  // a separate upload). Lets chip removal drop the knowledge file too.
  userFileId: Id<"userFiles"> | null;
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
          contentType: file.type || "application/octet-stream",
          ...(threadId ? { threadId: threadId as Id<"chatThreads"> } : {}),
        });

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
              headers: { "content-type": contentType },
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
            patch(localId, { userFileId });
          } catch {
            // Best-effort — the chat attachment already works without this.
          }
        })();
      } catch {
        patch(localId, { status: "error" });
        toast.error(`Couldn't upload ${file.name}`);
      }
    },
    [current, generateUploadUrl, register, saveKnowledgeFile, threadId, patch],
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
    clear,
    readyIds,
    uploading: items.some((i) => i.status === "uploading"),
  };
}
