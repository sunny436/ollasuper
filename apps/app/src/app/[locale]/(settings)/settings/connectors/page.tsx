"use client";

import { Button } from "@v1/ui/button";
import { ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { ConnectorCard } from "./_components/connector-card";
import { useConnect } from "./_hooks/use-connect";
import { useConnectors } from "./_hooks/use-connectors";
import { EMPTY, ERROR, PAGE } from "./_lib/copy";
import { categoriesOf, searchConnectors } from "./_lib/dto";

/**
 * Connectors — browse what this deployment offers, and manage what you connected.
 *
 * WHY SETTINGS AND NOT THE WORKSPACE RAIL. `skills/page.tsx` records the rule:
 * the rail holds things you OPERATE inside one workspace; Settings holds
 * owner-scoped configuration that follows the person. `mcpConnections` is
 * indexed `by_user` with deliberately no workspace-only index, and a credential
 * is somebody's personal account — so the rail would imply a boundary the data
 * does not have.
 *
 * ONE PAGE, NO TABS (§11). Your connections sit above the catalogue rather than
 * behind a click, because "what did I connect?" is the question this screen
 * exists to answer and a tab would hide it on the screen whose job is showing
 * it. The connected region is omitted entirely when empty, so a first-time user
 * sees a clean catalogue rather than an empty heading.
 *
 * NO PER-CONNECTOR CHAT TOGGLE, AND THAT IS A BACKEND FACT. `dispatchPayload`
 * selects every connection with `status === "ready"` in the current workspace
 * (`chat/stream.ts`). A switch here would be a frontend-only enable that
 * contradicts backend policy — exactly what §107 forbids. Connect and
 * disconnect ARE the control.
 */

export default function ConnectorsPage() {
  const {
    views,
    workspaceId,
    loading,
    catalogueError,
    remoteEnabled,
    busy,
    setBusy,
    reloadCatalogue,
  } = useConnectors();
  const { connect, pendingAuthUrl, dismissAuthUrl } = useConnect(
    workspaceId,
    setBusy,
  );

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  const categories = useMemo(() => categoriesOf(views), [views]);
  const filtered = useMemo(() => {
    const byCategory = category
      ? views.filter((v) => v.category === category)
      : views;
    return searchConnectors(byCategory, query);
  }, [views, category, query]);

  const connected = useMemo(
    () => filtered.filter((v) => v.connectionId !== null),
    [filtered],
  );
  const rest = useMemo(
    () => filtered.filter((v) => v.connectionId === null),
    [filtered],
  );

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">
          {PAGE.title}
        </h1>
        <p className="mt-1 max-w-xl text-sm text-primary/65">{PAGE.subtitle}</p>
      </header>

      {/* §182: one sentence of education, and it names the approval guarantee
          rather than leaving the user to wonder. */}
      <p className="rounded-lg border border-border bg-card p-3 text-xs leading-relaxed text-primary/65">
        {PAGE.about}
      </p>

      {/* A blocked popup is its own state with its own recovery (§55): the
          authorization URL is offered as a plain link the user can click
          themselves. It is minted by the backend and carries no token. */}
      {pendingAuthUrl && (
        <div className="rounded-lg border border-warning bg-muted p-3">
          <p className="text-xs font-medium text-primary">
            {ERROR.popupBlocked.title}
          </p>
          <p className="mt-0.5 text-xs text-primary/60">
            {ERROR.popupBlocked.body}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <a
              href={pendingAuthUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-brand-ink underline"
            >
              {ERROR.popupBlocked.action}
              <ExternalLink aria-hidden className="h-3 w-3" />
            </a>
            <button
              type="button"
              onClick={dismissAuthUrl}
              className="text-xs text-primary/65 underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={PAGE.searchPlaceholder}
          aria-label={PAGE.searchPlaceholder}
          className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-primary/80 outline-none transition placeholder:text-muted-foreground focus:border-brand/40"
        />
      </div>

      {categories.length > 1 && (
        // Rendered only when there is a choice to make. A single-category
        // deployment gets no filter row rather than one useless button (§13).
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
          <CategoryChip
            label="All"
            active={category === null}
            onClick={() => setCategory(null)}
          />
          {categories.map((c) => (
            <CategoryChip
              key={c}
              label={views.find((v) => v.category === c)?.categoryLabel ?? c}
              active={category === c}
              onClick={() => setCategory(category === c ? null : c)}
            />
          ))}
        </div>
      )}

      {loading && <SkeletonGrid />}

      {!loading && catalogueError && (
        <ErrorPanel
          title={ERROR.catalogue.title}
          body={ERROR.catalogue.body}
          action={ERROR.catalogue.action}
          onAction={reloadCatalogue}
        />
      )}

      {/* THE GLOBAL KILL SWITCH, rendered as a state rather than as an error.
          `mcp_connections_enabled=false` is a deployment decision: there is
          nothing to retry and nothing the user can do, so this panel carries no
          action at all (§55's rule, applied in the one case where the honest
          recovery is "none"). */}
      {!loading && !catalogueError && !remoteEnabled && (
        <EmptyPanel {...EMPTY.disabled} />
      )}

      {!loading && !catalogueError && remoteEnabled && views.length === 0 && (
        <EmptyPanel {...EMPTY.catalogue} />
      )}

      {!loading && !catalogueError && views.length > 0 && filtered.length === 0 && (
        <EmptyPanel {...EMPTY.search} />
      )}

      {connected.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-primary/70">
            {PAGE.yourConnections}
          </h2>
          <Grid views={connected} onRun={connect} />
        </section>
      )}

      {rest.length > 0 && (
        <section className="flex flex-col gap-3">
          {connected.length > 0 && (
            <h2 className="text-sm font-medium text-primary/70">{PAGE.browse}</h2>
          )}
          <Grid views={rest} onRun={connect} />
        </section>
      )}
    </div>
  );
}

/** Two columns from `sm` up, one below — inside the layout's `max-w-content`
 *  column (70% of the pane, never under 768px). No settings page opts out of
 *  that width, and a two-up grid fits it at every size, so the catalogue needs
 *  no layout exception of its own. */
function Grid({
  views,
  onRun,
}: {
  views: ReturnType<typeof searchConnectors>;
  onRun: (v: (typeof views)[number]) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {views.map((v) => (
        <ConnectorCard key={v.serverName} view={v} onRun={onRun} />
      ))}
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:text-xs ${
        active
          ? "border-border bg-card font-medium text-primary"
          : "border-transparent text-primary/65 hover:bg-card hover:text-primary/80"
      }`}
    >
      {label}
    </button>
  );
}

/** Fixed-height placeholders so the grid does not reflow when data lands
 *  (§53: no layout jump). */
function SkeletonGrid() {
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      aria-busy="true"
      aria-label="Loading connectors"
    >
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-[132px] animate-pulse rounded-xl border border-border bg-card"
        />
      ))}
    </div>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center">
      <p className="text-sm font-medium text-primary/70">{title}</p>
      <p className="mt-1 text-xs text-primary/60">{body}</p>
    </div>
  );
}

function ErrorPanel({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 text-center">
      <p className="text-sm font-medium text-primary/80">{title}</p>
      <p className="mt-1 text-xs text-primary/65">{body}</p>
      {/* §213: every recoverable error offers the action that recovers it. */}
      <Button size="sm" variant="outline" className="mt-3" onClick={onAction}>
        {action}
      </Button>
    </div>
  );
}
