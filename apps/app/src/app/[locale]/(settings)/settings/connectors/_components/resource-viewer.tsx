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
import { ScrollArea } from "@v1/ui/scroll-area";
import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import type { ResourceItem } from "../_hooks/use-capabilities";

/**
 * Read one resource, on explicit request, and show it as TEXT.
 *
 * NOTHING IS FETCHED UNTIL A USER ASKS (§28). A resource body is arbitrary
 * third-party content; auto-loading every one on a detail page would be both a
 * page-load cost and a decision made on the user's behalf.
 *
 * RENDERED IN A `<pre>`, NEVER PARSED. A resource can be HTML, SVG, or anything
 * else a server chooses to return, and §74 is explicit that it must not execute.
 * Text in a `<pre>` is the strongest available guarantee: the browser never
 * builds nodes from it, so there is nothing for a script to hang off. Markdown
 * rendering was considered and rejected — the app's renderer is safe, but it is
 * built for MODEL output and reusing it here would extend its blast radius to a
 * new, untrusted source for a cosmetic gain.
 *
 * THE BYTE BOUND IS THE BACKEND'S. `read_resource` truncates at
 * `mcp_resource_max_bytes` (128KB) and says so in its payload, and binary
 * content is REFUSED rather than decoded — so this component never has to
 * decide what to do with a 40MB image or a zip file.
 */
export function ResourceViewer({
  connectionId,
  resource,
  onClose,
}: {
  connectionId: string;
  resource: ResourceItem | null;
  onClose: () => void;
}) {
  const read = useAction(api.mcp.capabilities.readResource);
  const [state, setState] = useState<{
    loading: boolean;
    text: string | null;
    error: string | null;
    truncated: boolean;
  }>({ loading: false, text: null, error: null, truncated: false });

  useEffect(() => {
    if (!resource) return;
    let cancelled = false;
    setState({ loading: true, text: null, error: null, truncated: false });
    void read({
      connectionId: connectionId as Id<"mcpConnections">,
      uri: resource.uri,
    })
      .then((res) => {
        if (cancelled) return;
        if (typeof res?.error === "string" && res.error) {
          setState({
            loading: false,
            text: null,
            error: res.error,
            truncated: false,
          });
          return;
        }
        const text = typeof res?.text === "string" ? res.text : null;
        setState({
          loading: false,
          // A resource with no text is a resource the backend refused to decode
          // — binary, or an unsupported kind. Saying so beats an empty box.
          text,
          error: text === null ? "This resource can't be shown as text." : null,
          truncated: res?.truncated === true,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          loading: false,
          text: null,
          error: "This resource could not be read.",
          truncated: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, resource, read]);

  return (
    <Dialog open={resource !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="workspace max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate">{resource?.name ?? ""}</DialogTitle>
          {resource?.description && (
            <DialogDescription>{resource.description}</DialogDescription>
          )}
        </DialogHeader>

        {state.loading && (
          <div
            className="h-40 animate-pulse rounded-lg border border-border bg-card/40"
            aria-busy="true"
            aria-label="Loading resource"
          />
        )}

        {!state.loading && state.error && (
          <p className="rounded-lg border border-border bg-card/40 p-3 text-xs text-primary/60">
            {state.error}
          </p>
        )}

        {!state.loading && state.text !== null && (
          <ScrollArea className="max-h-[50vh] rounded-lg border border-border bg-card/40">
            {/* `pre` + `whitespace-pre-wrap`: the content is shown, never
                interpreted. `overflow-x-auto` on the wrapper keeps a long line
                inside its own scroller instead of widening the page. */}
            <pre className="overflow-x-auto p-3 text-[11px] leading-relaxed text-primary/70 [white-space:pre-wrap] [overflow-wrap:anywhere]">
              {state.text}
            </pre>
          </ScrollArea>
        )}

        {state.truncated && (
          <p className="text-[11px] text-primary/60">
            Shown up to OllaSuper's size limit. The rest was not loaded.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
