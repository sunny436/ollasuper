"use client";

import { sha256Hex } from "@/lib/knowledge-file";
import {
  type LibraryUploadDeps,
  type SpaceReason,
  type UploadResult,
  uploadToLibrary,
} from "@/lib/library";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useConvex, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import type { DuplicateChoice, DuplicateQuestion } from "./upload-dialogs";

/** A server refusal's own words (libraryError carries {code, message}). */
export function libraryErrorMessage(e: unknown, fallback = "Upload failed"): string {
  if (e instanceof ConvexError) {
    const d = e.data as unknown;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && "message" in d) return String((d as { message: unknown }).message);
  }
  if (e instanceof Error && /too large/i.test(e.message)) return e.message;
  return fallback;
}

type Pending = { fileName: string; size: number; reason: SpaceReason };

/** The file an upload resolved to: a new one, or (when the user chose it) the one they had. */
export type UploadedFile = { fileId: Id<"userFiles">; reused: boolean };

/** The user said no (a question's Cancel) — distinct from a refusal, which is toasted. */
export const CANCELLED = { cancelled: true } as const;
export type UploadOutcome = UploadedFile | typeof CANCELLED | null;

export type UploadOptions = {
  purpose: "library" | "chat";
  onProgress?: (pct: number) => void;
  /**
   * When the user already has these bytes, may they use that file instead?
   * Yes for a chat or a Project (a reference is all they need); no on the
   * Library page, where the only question is whether to keep a second copy.
   */
  offerReuse: boolean;
};

export type LibraryUploadDialogProps = {
  space: {
    open: boolean;
    pending: Pending | null;
    onOpenChange: (open: boolean) => void;
    onConfirm: (ids: Id<"userFiles">[]) => Promise<void>;
  };
  duplicate: {
    question: DuplicateQuestion | null;
    onAnswer: (choice: DuplicateChoice | null) => void;
  };
};

/**
 * One upload into the Library, asking the user whenever a decision is theirs.
 *
 * `upload` resolves the resulting file, CANCELLED when the user said no, or
 * null when the server refused (already toasted). It may ask two questions, each WAITING for
 * the answer: "you already have this file" (identical bytes are allowed to be
 * two files — nothing is ever merged silently), and "Free up space" when the
 * file does not fit (the chosen files are deleted by the server only together
 * with the new upload). Render `<LibraryUploadDialogs {...dialogs} />`.
 */
export function useLibraryUpload(workspaceId: Id<"workspaces"> | null) {
  const convex = useConvex();
  const beginUpload = useMutation(api.library.beginUpload);
  const finishUpload = useMutation(api.library.finishUpload);
  const abortUpload = useMutation(api.library.abortUpload);
  const [pending, setPending] = useState<Pending | null>(null);
  const [question, setQuestion] = useState<DuplicateQuestion | null>(null);
  const spaceAnswer = useRef<((ids: Id<"userFiles">[] | null) => void) | null>(null);
  const dupAnswer = useRef<((c: DuplicateChoice | null) => void) | null>(null);

  const settleSpace = useCallback((ids: Id<"userFiles">[] | null) => {
    const resolve = spaceAnswer.current;
    spaceAnswer.current = null;
    setPending(null);
    resolve?.(ids);
  }, []);

  const settleDup = useCallback((c: DuplicateChoice | null) => {
    const resolve = dupAnswer.current;
    dupAnswer.current = null;
    setQuestion(null);
    resolve?.(c);
  }, []);

  const askSpace = useCallback(
    (file: File, reason: SpaceReason) =>
      new Promise<Id<"userFiles">[] | null>((resolve) => {
        spaceAnswer.current?.(null); // one question at a time
        spaceAnswer.current = resolve;
        setPending({ fileName: file.name, size: file.size, reason });
      }),
    [],
  );

  const askDup = useCallback(
    (q: DuplicateQuestion) =>
      new Promise<DuplicateChoice | null>((resolve) => {
        dupAnswer.current?.(null);
        dupAnswer.current = resolve;
        setQuestion(q);
      }),
    [],
  );

  /** The user's own file with these bytes, if any. Advisory: failures skip it. */
  const existingCopy = useCallback(
    async (file: File) => {
      if (!workspaceId) return null;
      try {
        const sha256 = await sha256Hex(file);
        return await convex.query(api.library.findDuplicate, { workspaceId, sha256 });
      } catch {
        return null;
      }
    },
    [convex, workspaceId],
  );

  const upload = useCallback(
    async (file: File, opts: UploadOptions): Promise<UploadOutcome> => {
      if (!workspaceId) return null;
      const existing = await existingCopy(file);
      if (existing) {
        const choice = await askDup({ fileName: file.name, existing, offerReuse: opts.offerReuse });
        if (choice === null) return CANCELLED;
        if (choice === "reuse") return { fileId: existing._id, reused: true };
      }
      const deps: LibraryUploadDeps = { beginUpload, finishUpload, abortUpload };
      let approved: Id<"userFiles">[] | undefined;
      // Bounded: each round is a user decision; a third "state changed" in a
      // row means something else is racing this upload.
      for (let round = 0; round < 3; round++) {
        let r: UploadResult;
        try {
          r = await uploadToLibrary(deps, {
            workspaceId,
            file,
            purpose: opts.purpose,
            approvedDeletions: approved,
            onProgress: opts.onProgress,
          });
        } catch (e) {
          toast.error(`${file.name}: ${libraryErrorMessage(e)}`);
          return null;
        }
        if (r.ok) {
          if (r.evicted.length > 0) {
            toast.success(
              `Deleted ${r.evicted.length} file${r.evicted.length === 1 ? "" : "s"} to make room for ${file.name}`,
            );
          }
          return { fileId: r.fileId, reused: false };
        }
        if ("message" in r) {
          toast.error(`${file.name}: ${r.message}`);
          return null;
        }
        const ids = await askSpace(file, r.space.reason);
        if (!ids) return CANCELLED;
        approved = ids;
      }
      toast.error(`${file.name}: your files keep changing — try again`);
      return null;
    },
    [workspaceId, beginUpload, finishUpload, abortUpload, askSpace, askDup, existingCopy],
  );

  const dialogs: LibraryUploadDialogProps = {
    space: {
      open: pending !== null,
      pending,
      onOpenChange: (open: boolean) => {
        if (!open) settleSpace(null);
      },
      onConfirm: async (ids: Id<"userFiles">[]) => settleSpace(ids),
    },
    duplicate: { question, onAnswer: settleDup },
  };

  return { upload, dialogs };
}
