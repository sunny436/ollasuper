"use client";

import { FileText } from "lucide-react";
import { useState } from "react";

type Att = { name: string; contentType: string; kind: string; size: number };

/**
 * A read-only shared attachment. Images render inline through the revocable
 * /share/file proxy; if the blob is gone (deleted / revoked mid-view) or is a
 * non-image, it degrades to a labelled chip rather than a broken image.
 */
export function ShareAttachment({ att, url }: { att: Att; url: string }) {
  const [broken, setBroken] = useState(false);
  const isImage = att.kind === "image" && !broken;

  if (isImage) {
    return (
      <img
        src={url}
        alt={att.name}
        onError={() => setBroken(true)}
        className="max-h-80 max-w-full rounded-lg border border-border object-contain"
      />
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-primary/80 transition hover:text-primary"
    >
      <FileText className="h-4 w-4 text-primary/45" />
      <span className="truncate">{att.name}</span>
    </a>
  );
}
