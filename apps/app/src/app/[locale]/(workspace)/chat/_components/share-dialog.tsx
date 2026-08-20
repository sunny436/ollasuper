"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@v1/ui/dialog";
import { useMutation } from "convex/react";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { socialShareUrls } from "../_lib/social-share";

export type ShareParams =
  | { shareType: "full_chat"; threadId: string }
  | { shareType: "single_turn"; messageId: Id<"chatMessages"> }
  | null;

/**
 * Share modal for a whole conversation or a single turn. Creates the link ONCE
 * per open (dedup on the server), then shows Copy + social buttons + the expiry.
 * Radix portals to document.body, so DialogContent carries `className="workspace"`
 * to keep the glass tokens (model-picker.tsx precedent).
 */
export function ShareDialog({
  open,
  onOpenChange,
  params,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  params: ShareParams;
}) {
  const create = useMutation(api.chat.shares.create);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [link, setLink] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const requested = useRef(false);

  useEffect(() => {
    if (!open) {
      // Reset for the next open (also clears the strict-mode double-invoke guard).
      requested.current = false;
      setStatus("loading");
      setLink("");
      setCopied(false);
      return;
    }
    if (!params || requested.current) return;
    requested.current = true;
    void doCreate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function doCreate(forceNew: boolean) {
    if (!params) return;
    setStatus("loading");
    try {
      const res =
        params.shareType === "full_chat"
          ? await create({
              shareType: "full_chat",
              threadId: params.threadId,
              forceNew,
            })
          : await create({
              shareType: "single_turn",
              messageId: params.messageId,
              forceNew,
            });
      setLink(`${window.location.origin}/share/${res.token}`);
      setExpiresAt(res.expiresAt);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }

  function copy() {
    navigator.clipboard?.writeText(link).then(
      () => {
        setCopied(true);
        toast.success("Link copied");
        setTimeout(() => setCopied(false), 1600);
      },
      () => toast.error("Couldn't copy the link"),
    );
  }

  const isTurn = params?.shareType === "single_turn";
  const social = link ? socialShareUrls(link, "Shared conversation") : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="workspace">
        <DialogHeader>
          <DialogTitle>
            {isTurn ? "Share response" : "Share conversation"}
          </DialogTitle>
          <DialogDescription>
            Anyone with this link can view a read-only snapshot. This link
            expires in 7 days.
          </DialogDescription>
        </DialogHeader>

        {status === "loading" && (
          <p className="py-2 text-sm text-primary/60">Creating a share link…</p>
        )}
        {status === "error" && (
          <div className="py-2">
            <p className="text-sm text-red-500">
              Couldn't create a share link.
            </p>
            <button
              type="button"
              onClick={() => void doCreate(false)}
              className="mt-2 text-xs text-brand-ink hover:underline"
            >
              Try again
            </button>
          </div>
        )}
        {status === "ready" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={link}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-primary/80"
              />
              <button
                type="button"
                onClick={copy}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-medium text-brand-foreground transition hover:brightness-110"
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {social &&
                (
                  [
                    ["LinkedIn", social.linkedin],
                    ["X", social.x],
                    ["WhatsApp", social.whatsapp],
                  ] as const
                ).map(([label, href]) => (
                  <a
                    key={label}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-primary/75 transition hover:bg-primary/5 hover:text-primary"
                  >
                    {label}
                  </a>
                ))}
            </div>

            <div className="flex items-center justify-between border-t border-border pt-3">
              <p className="text-xs text-primary/45">
                {expiresAt
                  ? `Expires ${new Date(expiresAt).toLocaleDateString()}.`
                  : "Expires in 7 days."}
              </p>
              <button
                type="button"
                onClick={() => void doCreate(true)}
                className="text-xs text-brand-ink hover:underline"
              >
                Create a new link
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
