"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { Button } from "@v1/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@v1/ui/dialog";
import { Input } from "@v1/ui/input";
import { ScrollArea } from "@v1/ui/scroll-area";
import { useAction } from "convex/react";
import { useState } from "react";
import type { PromptItem } from "../_hooks/use-capabilities";

/**
 * Fill a prompt's arguments and see what it produces.
 *
 * A PROMPT IS NOT AN OLLASUPER SYSTEM PROMPT (§33). It is text an external
 * server composes, and the backend enforces that: `normalize_prompt_messages`
 * maps every message to `user` or `assistant` and there is no path by which one
 * can become a system or developer instruction. This dialog therefore SHOWS the
 * result rather than applying it — the user reads what the server produced and
 * decides what to do with it, which is the honest shape for third-party content
 * and the reason §31 says prompts must not auto-execute.
 *
 * VALIDATION IS THE BACKEND'S (§32). The `required` marks below come from the
 * server's own declaration and are used for a `required` attribute and a
 * disabled submit — a convenience, not a gate. Python validates against the same
 * declaration before anything is sent, and it does so because a real server
 * answers both a missing argument and an unknown one with "Internal server
 * error": a 400 naming the field is the only usable answer, and it has to come
 * from the side that knows.
 */
export function PromptRunDialog({
  connectionId,
  prompt,
  onClose,
}: {
  connectionId: string;
  prompt: PromptItem | null;
  onClose: () => void;
}) {
  const getPrompt = useAction(api.mcp.capabilities.getPrompt);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<
    Array<{ role: string; content: string }> | null
  >(null);

  const args = prompt?.arguments ?? [];
  const missing = args
    .filter((a) => a.required)
    .some((a) => !(values[a.name] ?? "").trim());

  const close = () => {
    setValues({});
    setMessages(null);
    setError(null);
    onClose();
  };

  const run = async () => {
    if (!prompt) return;
    setBusy(true);
    setError(null);
    setMessages(null);
    try {
      const res = await getPrompt({
        connectionId: connectionId as Id<"mcpConnections">,
        promptName: prompt.name,
        // String-valued because that is the protocol: `GetPromptRequest`
        // carries `dict[str, str]`.
        arguments: values,
      });
      if (typeof res?.error === "string" && res.error) {
        // Already classified and bounded upstream — a sentence naming the
        // offending field, not a stack trace.
        setError(res.error);
        return;
      }
      const list = Array.isArray(res?.messages) ? res.messages : [];
      setMessages(
        list
          .map((m) => {
            const row = m as Record<string, unknown>;
            return {
              role: typeof row.role === "string" ? row.role : "user",
              content: typeof row.content === "string" ? row.content : "",
            };
          })
          .filter((m) => m.content.length > 0),
      );
    } catch {
      setError("This prompt could not be loaded.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={prompt !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="workspace max-w-xl">
        <DialogHeader>
          <DialogTitle className="truncate">{prompt?.name ?? ""}</DialogTitle>
          <DialogDescription>
            {prompt?.description ??
              "A prompt template provided by this connector."}
          </DialogDescription>
        </DialogHeader>

        {args.length > 0 && (
          <div className="flex flex-col gap-3">
            {args.map((a) => (
              <label key={a.name} className="flex flex-col gap-1">
                <span className="text-xs font-medium text-primary/70">
                  {a.name}
                  {a.required && (
                    <span className="ml-1 text-primary/60">(required)</span>
                  )}
                </span>
                {a.description && (
                  <span className="text-[11px] text-primary/60">
                    {a.description}
                  </span>
                )}
                <Input
                  value={values[a.name] ?? ""}
                  required={a.required}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [a.name]: e.target.value }))
                  }
                />
              </label>
            ))}
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-border bg-card p-3 text-xs text-primary/60">
            {error}
          </p>
        )}

        {messages && (
          <ScrollArea className="max-h-[40vh] rounded-lg border border-border bg-card">
            <div className="flex flex-col gap-2 p-3">
              {messages.map((m, i) => (
                <div key={`${m.role}-${i}`}>
                  <p className="text-[10px] font-medium uppercase tracking-wide text-primary/60">
                    {m.role}
                  </p>
                  {/* TEXT, never markdown and never HTML. §75. */}
                  <pre className="mt-0.5 text-[11px] leading-relaxed text-primary/70 [white-space:pre-wrap] [overflow-wrap:anywhere]">
                    {m.content}
                  </pre>
                </div>
              ))}
              {messages.length === 0 && (
                <p className="text-xs text-primary/65">
                  This prompt produced no content.
                </p>
              )}
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            Close
          </Button>
          <Button onClick={run} disabled={busy || missing}>
            {busy ? "…" : "Show prompt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
