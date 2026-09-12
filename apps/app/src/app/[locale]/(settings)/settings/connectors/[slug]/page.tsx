"use client";

import { ConfirmButton } from "@/components/confirm-button";
import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { Button } from "@v1/ui/button";
import { useQuery } from "convex/react";
import { ArrowLeft, HardDrive } from "lucide-react";
import Link from "next/link";
import { use, useMemo, useState } from "react";
import { CapabilityList, CapabilityRow } from "../_components/capability-list";
import { CapabilitySummary } from "../_components/capability-summary";
import { ConnectAction } from "../_components/connect-action";
import {
  ConnectionHint,
  ConnectionStatus,
} from "../_components/connection-status";
import { PromptRunDialog } from "../_components/prompt-run-dialog";
import { ResourceViewer } from "../_components/resource-viewer";
import type { PromptItem, ResourceItem } from "../_hooks/use-capabilities";
import { useCapabilities } from "../_hooks/use-capabilities";
import { useConnect } from "../_hooks/use-connect";
import { useConnectors } from "../_hooks/use-connectors";
import { CONFIRM, EMPTY, PAGE } from "../_lib/copy";

/**
 * One connector: what it is, whether it is connected, and what it provides.
 *
 * THE SLUG COMES FROM THE URL, SO IT IS NEVER A `v.id()`. It is looked up in the
 * catalogue the page already loaded and used for nothing else — the same rule
 * `threadId` follows in chat, and for the same measured reason: an
 * `ArgumentValidationError` from a typo'd URL is logged by the Convex client as
 * a `console.error`, and every e2e script fails on one. A slug that matches
 * nothing renders "not found", not an exception.
 *
 * CAPABILITIES LOAD ONLY HERE AND ONLY WHEN CONNECTED. Each listing opens a real
 * MCP session in the Python plane, so the catalogue page never triggers one
 * (§119/§211) and a disconnected connector triggers none at all.
 */
export default function ConnectorDetailPage({
  params,
}: {
  // Next 15: params is a Promise even in a client component.
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { views, workspaceId, loading, setBusy } = useConnectors();
  const { connect, refresh, disconnect } = useConnect(workspaceId, setBusy);

  const view = useMemo(
    () => views.find((v) => v.slug === slug) ?? null,
    [views, slug],
  );

  // One row, not the list: `listWithAuth` deliberately projects `toolNames`
  // away because it re-sends its whole result to every subscriber on any write.
  const row = useQuery(
    api.mcp.connections.get,
    view?.connectionId
      ? { connectionId: view.connectionId as Id<"mcpConnections"> }
      : "skip",
  );

  const connected = view?.state === "CONNECTED";
  const { resources, prompts } = useCapabilities(
    view?.connectionId ?? null,
    connected,
  );

  const [openResource, setOpenResource] = useState<ResourceItem | null>(null);
  const [openPrompt, setOpenPrompt] = useState<PromptItem | null>(null);

  if (loading) {
    return (
      <div
        className="h-64 animate-pulse rounded-xl border border-border bg-card/40"
        aria-busy="true"
        aria-label="Loading connector"
      />
    );
  }

  if (!view) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="text-sm font-medium text-primary/70">
            Connector not found
          </p>
          <p className="mt-1 text-xs text-primary/45">
            This connector isn't available on this deployment.
          </p>
        </div>
      </div>
    );
  }

  const toolNames = Array.isArray(row?.toolNames) ? row.toolNames : [];

  return (
    <div className="flex flex-col gap-6">
      <BackLink />

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-primary">
              {view.displayName}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-xs text-primary/45">
                {view.categoryLabel}
              </span>
              {view.runtime === "local" && (
                <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-primary/50">
                  <HardDrive aria-hidden className="h-3 w-3" />
                  Runs locally
                </span>
              )}
            </div>
          </div>
          <ConnectAction view={view} onRun={connect} />
        </div>

        {view.description && (
          <p className="max-w-xl text-sm leading-relaxed text-primary/60">
            {view.description}
          </p>
        )}
      </header>

      <section className="flex flex-col gap-2 rounded-xl border border-border bg-card/40 p-4">
        <ConnectionStatus state={view.state} size="md" />
        <ConnectionHint state={view.state} />
        {view.runtime === "local" && (
          <p className="text-xs text-primary/45">{PAGE.localAbout}</p>
        )}
        {/* §110/§111: whose connection this is, in the only terms the backend
            actually records. There is no account label anywhere in the schema,
            so none is invented. */}
        {view.connectionId && (
          <p className="text-[11px] text-primary/40">
            Personal connection · used in this workspace
          </p>
        )}
      </section>

      {view.connectionId && (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-primary/70">Capabilities</h2>
            {connected && (
              <Button size="sm" variant="outline" onClick={() => refresh(view)}>
                Refresh
              </Button>
            )}
          </div>

          <CapabilitySummary
            toolCount={view.toolCount}
            resourceCount={
              connected && !resources.loading && !resources.error
                ? resources.items.length
                : undefined
            }
            promptCount={
              connected && !prompts.loading && !prompts.error
                ? prompts.items.length
                : undefined
            }
            onRetry={() => refresh(view)}
          />

          {connected && (
            <>
              <CapabilityList
                title="Tools"
                items={toolNames}
                loading={false}
                error={null}
                empty={EMPTY.tools}
                renderItem={(name: string, i) => (
                  <CapabilityRow
                    key={`${name}-${i}`}
                    name={name}
                    // §27: a tool existing is not a tool being safe. Every MCP
                    // tool from an untrusted server goes through the ordinary
                    // approval gate, and saying so once here beats a badge on
                    // every row that nobody reads.
                  />
                )}
              />
              {view.toolCount !== null && toolNames.length > 0 &&
                view.toolCount > toolNames.length && (
                  <p className="text-[11px] text-primary/45">
                    and {view.toolCount - toolNames.length} more
                  </p>
                )}
              <p className="text-[11px] text-primary/45">
                Tools that change something ask for your approval before they
                run.
              </p>

              <CapabilityList
                title="Resources"
                items={resources.items}
                loading={resources.loading}
                error={resources.error}
                dropped={resources.dropped}
                empty={EMPTY.resources}
                onRetry={resources.reload}
                renderItem={(r: ResourceItem, i) => (
                  <CapabilityRow
                    key={`${r.uri}-${i}`}
                    name={r.name || r.uri}
                    description={r.description}
                    meta={r.mime_type}
                    action={
                      <button
                        type="button"
                        onClick={() => setOpenResource(r)}
                        className="text-[11px] font-medium text-brand-ink underline"
                      >
                        Open
                      </button>
                    }
                  />
                )}
              />

              <CapabilityList
                title="Prompts"
                items={prompts.items}
                loading={prompts.loading}
                error={prompts.error}
                empty={EMPTY.prompts}
                onRetry={prompts.reload}
                renderItem={(p: PromptItem, i) => (
                  <CapabilityRow
                    key={`${p.name}-${i}`}
                    name={p.name}
                    description={p.description}
                    meta={
                      p.arguments?.length
                        ? `${p.arguments.length} argument${p.arguments.length === 1 ? "" : "s"}`
                        : undefined
                    }
                    action={
                      <button
                        type="button"
                        onClick={() => setOpenPrompt(p)}
                        className="text-[11px] font-medium text-brand-ink underline"
                      >
                        Use
                      </button>
                    }
                  />
                )}
              />
            </>
          )}
        </section>
      )}

      {/* §183: technical facts exist, behind a disclosure, never in the way. */}
      <details className="rounded-xl border border-border bg-card/30 p-4">
        <summary className="cursor-pointer text-xs font-medium text-primary/60">
          About this connection
        </summary>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px]">
          <Detail label="Connector" value={view.serverName} />
          <Detail
            label="Runs"
            value={view.runtime === "local" ? "Locally" : "Over the internet"}
          />
          <Detail label="Sign-in" value={view.authKind} />
          {view.scope && <Detail label="Granted access" value={view.scope} />}
          {/* §105: the backend's own classified sentence, for support. Never a
              stack trace, a header or a URL — none of those reach the browser. */}
          {view.lastError && <Detail label="Last error" value={view.lastError} />}
        </dl>
      </details>

      {view.connectionId && (
        <div className="flex justify-end">
          <ConfirmButton
            label="Disconnect"
            title={CONFIRM.disconnect.title}
            description={CONFIRM.disconnect.description}
            confirmLabel={CONFIRM.disconnect.confirm}
            onConfirm={() => disconnect(view)}
          />
        </div>
      )}

      {view.connectionId && (
        <>
          <ResourceViewer
            connectionId={view.connectionId}
            resource={openResource}
            onClose={() => setOpenResource(null)}
          />
          <PromptRunDialog
            connectionId={view.connectionId}
            prompt={openPrompt}
            onClose={() => setOpenPrompt(null)}
          />
        </>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/settings/connectors"
      className="inline-flex w-fit items-center gap-1.5 text-xs text-primary/50 transition hover:text-primary/80"
    >
      <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
      {PAGE.title}
    </Link>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-primary/45">{label}</dt>
      <dd className="text-primary/70 [overflow-wrap:anywhere]">{value}</dd>
    </>
  );
}
