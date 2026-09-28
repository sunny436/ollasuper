"use client";

import { fmtBytes } from "@/lib/library";
import { Button } from "@v1/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@v1/ui/dialog";
import { FreeUpSpaceDialog } from "./free-up-space-dialog";
import type { LibraryUploadDialogProps } from "./use-library-upload";

export type DuplicateChoice = "reuse" | "upload";

export type DuplicateQuestion = {
  fileName: string;
  existing: { name: string; size: number; createdAt: number };
  /** Chat and Projects can use the existing file; the Library page cannot. */
  offerReuse: boolean;
};

/**
 * "You already have this file". Identical bytes are allowed to be two files
 * (two names, two lifecycles) — this only offers the one the user already has,
 * and never merges anything.
 */
export function DuplicateDialog({
  question,
  onAnswer,
}: {
  question: DuplicateQuestion | null;
  onAnswer: (choice: DuplicateChoice | null) => void;
}) {
  const q = question;
  return (
    <Dialog open={q !== null} onOpenChange={(o) => !o && onAnswer(null)}>
      <DialogContent className="workspace sm:max-w-md">
        {q && (
          <>
            <DialogHeader>
              <DialogTitle className="text-base">You already have this file</DialogTitle>
              <DialogDescription>
                {q.fileName} has the same contents as <span className="font-medium">{q.existing.name}</span>{" "}
                ({fmtBytes(q.existing.size)}, added {new Date(q.existing.createdAt).toLocaleDateString()}).
                {q.offerReuse ? " Use that one, or upload another copy?" : " Upload another copy anyway?"}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => onAnswer(null)}>
                Cancel
              </Button>
              <Button variant={q.offerReuse ? "outline" : "default"} onClick={() => onAnswer("upload")}>
                Upload another copy
              </Button>
              {q.offerReuse && <Button onClick={() => onAnswer("reuse")}>Use the one I have</Button>}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Every question an upload can ask. Render once wherever useLibraryUpload is used. */
export function LibraryUploadDialogs({ space, duplicate }: LibraryUploadDialogProps) {
  return (
    <>
      <DuplicateDialog question={duplicate.question} onAnswer={duplicate.onAnswer} />
      <FreeUpSpaceDialog {...space} />
    </>
  );
}
