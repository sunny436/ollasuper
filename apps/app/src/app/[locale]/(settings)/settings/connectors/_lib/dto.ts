import { safeUrl } from "@v1/backend/convex/urlGuard";
import type {
  McpLocalSummary,
  McpServerSummary,
} from "@v1/backend/convex/mcp/catalogue";
import type { CredentialStatus } from "@v1/backend/convex/mcp/credentials";
import { categoryLabel } from "./copy";
import { type ConnectionStatus, type DisplayState, deriveState } from "./state";

/**
 * Catalogue rows + connection rows -> the one object a card renders.
 *
 * THE JOIN KEY IS `serverName`, NOT `slug`. A slug is short and human, and it
 * is what URLs and tool ids use — but `mcpConnections` is indexed on
 * `by_user_server` over `serverName`, and `connections.create` enforces
 * one-per-`(user, serverName)`. Joining on anything else would let two
 * catalogue entries that happen to share a slug collapse into one row.
 *
 * WHAT IS NOT HERE. No `connectionId` is exposed as a label (§21/§87), because
 * an opaque id is not an account name and there is no account name to show: the
 * backend records none, MCP does not report the authorized principal, and §22
 * forbids deriving identity from a token. The workspace and the granted scope
 * are the only honest answers, and both come straight from the backend.
 */

/** A connection row as `connections.listWithAuth` returns it. Structural rather
 *  than `Doc<"mcpConnections">` so this module stays testable without the
 *  Convex codegen in scope. */
export type ConnectionRow = {
  _id: string;
  serverName: string;
  slug: string;
  status: ConnectionStatus;
  version?: string;
  transport?: string;
  authKind?: string;
  toolCount?: number;
  capabilitiesAt?: number;
  lastError?: string;
  lastErrorKind?: string;
  userActionRequired?: boolean;
  lastConnectedAt?: number;
  updatedAt?: number;
  auth?: CredentialStatus;
};

export type ConnectorView = {
  /** Stable, URL-safe, and what the detail route is keyed on. */
  slug: string;
  serverName: string;
  displayName: string;
  category: string;
  categoryLabel: string;
  description: string | null;
  /** Presented as a detail only. The connect flow never branches on it — see
   *  `state.ts`. */
  authKind: string;
  /** Needed by `connections.create`, which stores it on the row. Not rendered:
   *  "streamable-http" is protocol vocabulary, not product copy. */
  transport: string;
  /** "remote" | "local". Deliberately not "docker"/"stdio"/"gateway": §34 asks
   *  for words a normal user can act on. */
  runtime: "remote" | "local";
  state: DisplayState;
  /** Present only when a connection row exists. Never rendered as a label. */
  connectionId: string | null;
  /** Null when discovery has not completed — NEVER 0. See §101. */
  toolCount: number | null;
  capabilitiesAt: number | null;
  lastErrorKind: string | null;
  lastError: string | null;
  /** The granted OAuth scope, when one exists. The only "what did I authorize"
   *  signal the backend actually has. */
  scope: string | null;
  /** Does a credential row exist for this connection?
   *
   *  `auth.updatedAt !== null` is the discriminator — `credentialStatusFor`
   *  returns null there from exactly one branch, the one where it found no row.
   *  It is NOT the same question as "is there a scope": a provider may issue a
   *  token and return no scope at all, and choosing the disconnect path on
   *  `scope` would then leave that credential behind. */
  hasCredential: boolean;
  connected: boolean;
};

function toolCountOf(row: ConnectionRow | undefined): number | null {
  // NEVER `row?.toolCount ?? 0`. A missing count means discovery did not
  // complete, and defaulting it to zero converts "unknown" into the confident
  // claim that the app offers nothing — the exact bug §101 names.
  if (!row || row.capabilitiesAt === undefined || row.status === "degraded") {
    return null;
  }
  return typeof row.toolCount === "number" ? row.toolCount : null;
}

export function toView(
  server: McpServerSummary,
  row: ConnectionRow | undefined,
  opts: { busy?: boolean; local?: McpLocalSummary } = {},
): ConnectorView {
  const state = deriveState({
    status: row?.status ?? null,
    lastErrorKind: row?.lastErrorKind ?? null,
    userActionRequired: row?.userActionRequired ?? false,
    auth: row?.auth ?? null,
    localState: opts.local ? (opts.local.state as "available" | "blocked") : null,
    busy: opts.busy,
  });
  return {
    slug: server.slug,
    serverName: server.serverName,
    displayName: server.displayName,
    category: server.category,
    categoryLabel: categoryLabel(server.category),
    description: server.description,
    authKind: server.authKind,
    transport: server.transport,
    runtime: opts.local ? "local" : "remote",
    state,
    connectionId: row?._id ?? null,
    toolCount: toolCountOf(row),
    capabilitiesAt: row?.capabilitiesAt ?? null,
    lastErrorKind: row?.lastErrorKind ?? null,
    lastError: row?.lastError ?? null,
    scope: row?.auth?.scope ?? null,
    hasCredential: !!row?.auth && row.auth.updatedAt !== null,
    connected: row?.status === "ready",
  };
}

/**
 * A local server, shaped like a catalogue entry.
 *
 * LOCAL ROWS ARE NOT CURATED ROWS, AND THEY NEVER OVERLAP. `mcp_local_servers`
 * is a separate table — "may this run remotely" and "may this run locally" are
 * independent operator decisions — and `validate_local_server` REFUSES a slug
 * already used by a curated remote server, because one slug is one provider in
 * `ToolRegistry` and two would let a local server shadow a remote one's tools.
 *
 * So a local server is an ADDITIONAL entry in the list, never an annotation on
 * an existing one. An earlier version of this file matched local rows onto
 * curated rows by slug, which the policy above guarantees can never match: the
 * local layer silently did nothing and local servers were invisible.
 *
 * `local/<slug>` IS THE SERVER NAME because that is what `gateway_spec` mints
 * and therefore what an `mcpConnections` row stores — so the join below finds a
 * local connection with no special case.
 */
function localAsServer(l: McpLocalSummary): McpServerSummary {
  return {
    serverName: `local/${l.slug}`,
    slug: l.slug,
    displayName: l.displayName,
    // A local row carries no category — the table has no such column — and
    // inventing one would put a fictional label on a card.
    category: "other",
    description: null,
    // The gateway injects a local server's secrets from its own store;
    // OllaSuper sends it no credential, which is what `gateway_spec` records.
    authKind: "none",
    transport: "streamable-http",
    catalogueStatus: "local",
  };
}

/** Join the catalogue to this user's connections, and append local servers.
 *
 *  Catalogue-driven, not connection-driven: a connection whose server has been
 *  de-curated disappears from the list rather than rendering a card with no
 *  metadata. The row itself is untouched — §113/§114, removing a server from the
 *  catalogue is not the same as deleting somebody's connection. */
export function joinConnectors(
  servers: McpServerSummary[] | null | undefined,
  rows: ConnectionRow[] | null | undefined,
  opts: { busy?: ReadonlySet<string>; local?: McpLocalSummary[] | null } = {},
): ConnectorView[] {
  const byServer = new Map<string, ConnectionRow>();
  for (const row of rows ?? []) byServer.set(row.serverName, row);

  const remote = (servers ?? []).map((s) =>
    toView(s, byServer.get(s.serverName), {
      busy: opts.busy?.has(s.serverName),
    }),
  );

  const local = (opts.local ?? []).map((l) => {
    const server = localAsServer(l);
    return toView(server, byServer.get(server.serverName), {
      busy: opts.busy?.has(server.serverName),
      local: l,
    });
  });

  return [...remote, ...local];
}

/**
 * Search across the things a person actually types (§12).
 *
 * Name, provider and category — not the reverse-DNS server id alone, which is
 * what a naive "search the primary key" implementation would do and which
 * nobody knows. The description is included because "email" and "calendar" are
 * far more likely to appear there than in a display name.
 *
 * Plain `includes` on a lowercased haystack: the set is ~30 rows, so a fuzzy
 * matcher would be machinery for a problem that does not exist.
 */
export function searchConnectors(
  views: ConnectorView[],
  query: string,
): ConnectorView[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return views;
  return views.filter((v) =>
    [
      v.displayName,
      v.slug,
      v.category,
      v.categoryLabel,
      v.description ?? "",
      // The reverse-DNS id is searched LAST and included only so a user who
      // knows it is not refused; it is never the only thing searched.
      v.serverName,
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

/** The categories actually present, in a stable order, for the filter row.
 *
 *  DERIVED FROM THE DATA rather than from a fixed list, so a deployment that
 *  curates only four categories does not show eight empty filters (§13). */
export function categoriesOf(views: ConnectorView[]): string[] {
  const seen = new Set<string>();
  for (const v of views) seen.add(v.category);
  return [...seen].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b)));
}

/**
 * An external link a card may render, or null.
 *
 * `safeUrl` is the app's existing guard, shared with the markdown renderer and
 * the report email renderer and unit-tested where it lives. It is reused rather
 * than reimplemented for the reason its own module gives: one implementation of
 * a security control beats two that can drift.
 *
 * https ONLY, beyond what `safeUrl` already refuses. A connector's homepage
 * arrives from the public registry, so `http:` is downgraded to nothing rather
 * than rendered — there is no reason to send a user to a plaintext page on the
 * strength of third-party metadata.
 */
export function externalLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const safe = safeUrl(raw);
  if (!safe) return null;
  return /^https:/i.test(safe) ? safe : null;
}
