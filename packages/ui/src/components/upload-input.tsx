"use client";

import { type InputHTMLAttributes, useRef, useState } from "react";
import { storageContentType } from "../lib/upload-content-type";

/** What a Convex upload POST returns. Kept structurally identical to the shape
 *  the previous (abandoned) uploadstuff dependency produced, so call sites are
 *  unchanged. */
export type UploadFileResponse = {
  name: string;
  type: string;
  size: number;
  response: { storageId: string };
};

/**
 * Upload a file to Convex storage and hand back its storageId.
 *
 * This replaced `@xixixao/uploadstuff`, which was abandoned at 0.0.5, shipped
 * raw TypeScript that no longer typechecks against React 19, and — the reason
 * it matters here — POSTed each file under its OWN content-type. That is the
 * exact input to the stored-XSS surface: Convex serves a blob with the type
 * given on the upload POST, and getUrl() puts it on the app's own origin.
 *
 * The backend guard is still the boundary that decides (convex/blobSafety.ts
 * refuses to register an executable blob). Neutering here as well means the
 * refusal is never reached for an ordinary upload, so a user uploading
 * `page.html` gets their file instead of an error.
 */
export function UploadInput({
  generateUploadUrl,
  onUploadComplete,
  ...props
}: {
  generateUploadUrl: () => Promise<string>;
  onUploadComplete: (uploaded: UploadFileResponse[]) => void;
} & Pick<
  InputHTMLAttributes<HTMLInputElement>,
  "accept" | "id" | "type" | "className" | "required" | "tabIndex"
>) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  return (
    <input
      ref={fileInputRef}
      type="file"
      disabled={busy}
      onChange={async (event) => {
        const files = Array.from(event.target.files ?? []);
        if (files.length === 0) return;
        setBusy(true);
        try {
          const uploaded: UploadFileResponse[] = [];
          for (const file of files) {
            const url = await generateUploadUrl();
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": storageContentType(file.type) },
              body: file,
            });
            if (!res.ok) throw new Error(`upload failed: ${res.status}`);
            const { storageId } = (await res.json()) as { storageId: string };
            uploaded.push({
              name: file.name,
              type: file.type,
              size: file.size,
              response: { storageId },
            });
          }
          // Clear first: onUploadComplete may unmount this input.
          if (fileInputRef.current) fileInputRef.current.value = "";
          onUploadComplete(uploaded);
        } finally {
          setBusy(false);
        }
      }}
      {...props}
    />
  );
}
