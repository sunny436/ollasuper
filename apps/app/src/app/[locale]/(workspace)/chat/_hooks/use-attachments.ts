"use client";

import { useLibraryUpload } from "@/components/library/use-library-upload";
import { accepted } from "@/lib/knowledge-file";
import { useWorkspace } from "@/lib/useWorkspace";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
   * The CLIENT's view of the attachment, and the only thing that gates Send.
   *
   * `ready` means the chat attachment row exists — NOT that the Library file's
   * processing finished: the text/image extraction for the turn happens at
   * generation time in the Python plane, independently of indexing. Do not
   * gate sending on the Library file's status.
   */
  status: "uploading" | "ready" | "error";
  attachmentId: Id<"chatAttachments"> | null;
  /**
   * The Library file this chip refers to. ONE upload is ONE Library file and
   * ONE blob; the chat attachment is a reference to it (it used to be a second
   * upload into a second copy).
   */
  userFileId: Id<"userFiles"> | null;
  /**
   * True when THIS chip's upload created the Library file. Removing such a chip
   * before sending deletes the file too (it was only ever uploaded for this
   * message); a chip added from the Library only drops its reference.
   */
  ownsFile: boolean;
  /**
   * Kept so a failed upload can be RETRIED in place (a File is a lazy handle
   * to disk, not a copy in memory). Null for a chip added from the Library,
   * whose retry re-attaches the existing file instead.
   */
  file: File | null;
  /**
   * The conversation this chip was added in (`threadId ?? "new"`).
   *
   * The composer is mounted ABOVE the route segment (chat-layout.tsx) so it
   * survives navigation, which means this hook's state survives it too. Without
   * a key an unsent chip followed the user from one chat into "New chat" (and
   * into any other chat), and was silently sent there. Only the current chat's
   * chips are exposed; the rest wait for the user to come back.
   */
  threadKey: string;
}

/** The composer-draft key for a conversation ("new" for the landing screen). */
export function threadKeyOf(threadId: string | null): string {
  return threadId ?? "new";
}

/** The chips that belong to the conversation on screen. */
export function chipsFor<T extends { threadKey: string }>(items: T[], key: string): T[] {
  return items.filter((i) => i.threadKey === key);
}

/**
 * Drop exactly the chips that were sent, wherever they are keyed now.
 *
 * NOT "clear the current conversation": the first send from the landing screen
 * switches threadId from null to the new thread's id mid-send, so by the time
 * the send resolves the current key is the NEW thread and the sent chips are
 * still keyed "new" — clearing by key would leave them behind, and they would
 * reappear on the next New chat.
 */
export function withoutChips<T extends { localId: string }>(items: T[], localIds: string[]): T[] {
  const gone = new Set(localIds);
  return items.filter((i) => !gone.has(i.localId));
}

const MAX_FILES = 6;
const MAX_BYTES = 20 * 1024 * 1024;

/** A file picked before the workspace resolved, held until it does. */
export interface WaitingUpload {
  file: File;
  localId: string;
}

/**
 * The held files to start now that the workspace has resolved: every one whose
 * chip was not removed meanwhile, in the order picked. Empties `waiting` and
 * consumes the matching cancellations (a removed chip has no upload to undo).
 */
export function releaseWaiting(
  waiting: WaitingUpload[],
  cancelled: Set<string>,
): WaitingUpload[] {
  const start = waiting.filter((w) => !cancelled.has(w.localId));
  for (const w of waiting) cancelled.delete(w.localId);
  waiting.length = 0;
  return start;
}

export function useAttachments(threadId: string | null) {
  const { current } = useWorkspace();
  const { upload: uploadToLibrary, dialogs: uploadDialogs } = useLibraryUpload(current ?? null);
  const attachLibraryFile = useMutation(api.chat.attachments.attachLibraryFile);
  const removeAttachment = useMutation(api.chat.attachments.remove);
  const removeLibraryFile = useMutation(api.userFiles.remove);
  const [all, setItems] = useState<PendingAttachment[]>([]);
  const key = threadKeyOf(threadId);
  const items = useMemo(() => chipsFor(all, key), [all, key]);
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
  /**
   * Files attached before the workspace resolved (the first second after page
   * load). `add` used to return on a null workspace, which dropped them with no
   * chip, no toast and no upload at all. They now show as uploading at once and
   * start the moment the workspace arrives.
   */
  const waiting = useRef<WaitingUpload[]>([]);

  const patch = useCallback(
    (localId: string, next: Partial<PendingAttachment>) => {
      setItems((prev) =>
        prev.map((i) => (i.localId === localId ? { ...i, ...next } : i)),
      );
    },
    [],
  );

  /**
   * Reference a Library file from this chat. Shared by a fresh upload and by
   * "Add from Library". If the chip was removed while this was in flight, the
   * reference (and a file this chip created) is undone here — whoever learns an
   * id first is responsible for deleting it.
   */
  const attach = useCallback(
    async (localId: string, fileId: Id<"userFiles">, ownsFile: boolean) => {
      if (!current) return;
      const dropOwned = () =>
        ownsFile ? removeLibraryFile({ fileId }).catch(() => {}) : Promise.resolve();
      if (cancelled.current.has(localId)) {
        cancelled.current.delete(localId);
        await dropOwned();
        return;
      }
      const attachmentId = await attachLibraryFile({
        fileId,
        workspaceId: current,
        ...(threadId ? { threadId: threadId as Id<"chatThreads"> } : {}),
      });
      if (cancelled.current.has(localId)) {
        cancelled.current.delete(localId);
        await removeAttachment({ attachmentId }).catch(() => {});
        await dropOwned();
        return;
      }
      patch(localId, { status: "ready", progress: 100, attachmentId, userFileId: fileId, ownsFile });
    },
    [current, threadId, attachLibraryFile, removeAttachment, removeLibraryFile, patch],
  );

  const upload = useCallback(
    async (file: File, localId: string) => {
      if (!current) return;
      try {
        // ONE upload into the Library (asking the user first if it does not
        // fit), then a reference from this chat — no second copy.
        const r = await uploadToLibrary(file, {
          purpose: "chat",
          offerReuse: true,
          onProgress: (pct) => patch(localId, { progress: pct }),
        });
        if (!r || "cancelled" in r) {
          if (cancelled.current.has(localId)) {
            cancelled.current.delete(localId);
            return;
          }
          if (r) {
            // The user answered Cancel: they do not want this file attached,
            // so the chip goes — a failed chip would block Send for nothing.
            setItems((prev) => {
              const gone = prev.find((i) => i.localId === localId);
              if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
              return prev.filter((i) => i.localId !== localId);
            });
            return;
          }
          patch(localId, { status: "error" }); // refused — already toasted
          return;
        }
        // Known before the reference exists, so a failed attach retries the
        // reference — never a second upload of the same file.
        // A file the user chose to REUSE ("you already have this file") is
        // theirs from before — removing the chip must not delete it.
        const owns = !r.reused;
        patch(localId, { userFileId: r.fileId, ownsFile: owns });
        await attach(localId, r.fileId, owns);
      } catch {
        // A cancelled upload that then fails needs no chip update and no toast:
        // the user already removed it and does not care that it failed.
        if (cancelled.current.has(localId)) {
          cancelled.current.delete(localId);
          return;
        }
        patch(localId, { status: "error" });
        toast.error(`Couldn't attach ${file.name}`);
      }
    },
    [current, uploadToLibrary, attach, patch],
  );

  useEffect(() => {
    if (!current) return;
    for (const w of releaseWaiting(waiting.current, cancelled.current)) {
      void upload(w.file, w.localId);
    }
  }, [current, upload]);

  const add = useCallback(
    (files: File[]) => {
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
            ownsFile: false,
            file,
            threadKey: key,
          },
        ]);
        if (current) void upload(file, localId);
        else waiting.current.push({ file, localId });
      }
    },
    [current, items.length, upload, key],
  );

  /** "Add from Library": a reference to an existing file — no upload, no copy. */
  const addFromLibrary = useCallback(
    (f: { _id: Id<"userFiles">; name: string; size: number; kind: string }) => {
      if (!current) {
        toast.error("Still loading — try again in a moment");
        return;
      }
      if (items.length >= MAX_FILES) {
        toast.error(`At most ${MAX_FILES} attachments per message`);
        return;
      }
      if (items.some((i) => i.userFileId === f._id)) return; // already attached
      counter.current += 1;
      const localId = `a${counter.current}`;
      setItems((prev) => [
        ...prev,
        {
          localId,
          name: f.name,
          size: f.size,
          contentType: "",
          isImage: f.kind === "image",
          previewUrl: null,
          progress: 100,
          status: "uploading",
          attachmentId: null,
          userFileId: f._id,
          ownsFile: false,
          file: null,
          threadKey: key,
        },
      ]);
      void attach(localId, f._id, false).catch(() => {
        patch(localId, { status: "error" });
        toast.error(`Couldn't attach ${f.name}`);
      });
    },
    [current, items, key, attach, patch],
  );

  const remove = useCallback(
    async (localId: string) => {
      const item = all.find((i) => i.localId === localId);
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
      // A file uploaded ONLY for this unsent message goes with the chip, so a
      // discarded attachment does not linger in the Library. A file added FROM
      // the Library is only un-referenced — it was the user's before.
      if (item?.userFileId && item.ownsFile && item.status !== "uploading") {
        try {
          await removeLibraryFile({ fileId: item.userFileId });
        } catch {
          // Best-effort; the file stays visible in the Library to delete there.
        }
      }
    },
    [all, removeAttachment, removeLibraryFile],
  );

  /**
   * Retry a failed chip in place: re-attach when the Library file already
   * exists (never a second upload of it), otherwise re-upload the retained File.
   */
  const retry = useCallback(
    (localId: string) => {
      const item = items.find((i) => i.localId === localId);
      if (!item || item.status !== "error") return;
      if (retrying.current.has(localId)) return;
      retrying.current.add(localId);
      // A retry that lands after the chip was removed must not resurrect it,
      // and a stale cancellation must not kill this fresh attempt.
      cancelled.current.delete(localId);
      patch(localId, { status: "uploading", progress: item.userFileId ? 100 : 0 });
      const run = item.userFileId
        ? attach(localId, item.userFileId, item.ownsFile)
        : item.file
          ? upload(item.file, localId)
          : Promise.resolve();
      void run
        .catch(() => {
          patch(localId, { status: "error" });
          toast.error(`Couldn't attach ${item.name}`);
        })
        .finally(() => {
          retrying.current.delete(localId);
        });
    },
    [items, patch, upload, attach],
  );

  /** Forget the chips that were just sent (by id — see withoutChips). */
  const clearSent = useCallback(
    (localIds: string[]) => {
      for (const i of all) {
        if (localIds.includes(i.localId) && i.previewUrl) URL.revokeObjectURL(i.previewUrl);
      }
      setItems((prev) => withoutChips(prev, localIds));
    },
    [all],
  );

  const readyIds = items
    .filter((i) => i.status === "ready" && i.attachmentId)
    .map((i) => i.attachmentId as Id<"chatAttachments">);

  return {
    items,
    add,
    addFromLibrary,
    remove,
    retry,
    clearSent,
    readyIds,
    // Render <LibraryUploadDialogs {...uploadDialogs} /> beside the composer.
    uploadDialogs,
    uploading: items.some((i) => i.status === "uploading"),
    // Names, not a count: the composer refuses a send that would quietly drop
    // an attachment, and it has to be able to say WHICH one.
    failed: items.filter((i) => i.status === "error").map((i) => i.name),
  };
}
