import type { CredentialStatus } from "@v1/backend/convex/mcp/credentials";

/**
 * ONE function decides what a connection looks like. Everything renders from it.
 *
 * WHY THIS EXISTS AT ALL. A connection's state is not one field, it is three
 * that can disagree:
 *
 *   mcpConnections.status        configured │ ready │ degraded │ failed │
 *                                disconnected │ unsupported
 *   mcpConnections.lastErrorKind auth_required │ auth_failed │ timeout │ …
 *   mcpCredentials (via auth)    AUTHORIZATION_REQUIRED │ REVOKED │
 *                                REAUTHORIZATION_REQUIRED │ TOKEN_EXPIRED │
 *                                CONNECTED
 *
 * `ready` + `TOKEN_EXPIRED` is reachable BY THE CLOCK ALONE — nothing rewrites
 * `status` when a token expires — so rendering the axes independently would
 * show "Connected" beside "expired" on the same card. The brief's §189 asks for
 * exactly this not to happen, and the only way to guarantee it is to make one
 * function the sole author of the answer.
 *
 * TWO TRAPS THIS ENCODES, both measured against the backend rather than assumed:
 *
 * 1. `AUTHORIZATION_REQUIRED` IS ALSO WHAT "NO CREDENTIAL ROW" MEANS.
 *    `credentialStatusFor` returns it from its `if (!row)` branch, so a server
 *    that needs no credential at all — `authKind: "none"` — reports it while
 *    working perfectly. Consulting auth unconditionally would render a healthy
 *    connection as "Authentication required". The discriminator is
 *    `auth.updatedAt`: only the no-row branch returns null there.
 *
 * 2. NOTHING HERE BRANCHES ON `authKind`. The catalogue cannot know whether a
 *    server speaks OAuth — the registry publishes no auth-scheme field and
 *    `registry/parse.py` refuses to infer one, so the column defaults to
 *    "unknown" and OAuth is discovered at RUNTIME from a 401 and its
 *    `WWW-Authenticate` challenge. The authority is therefore `lastErrorKind`
 *    plus `userActionRequired`, which is what the 401 actually produced.
 */

export type ConnectionStatus =
  | "configured"
  | "ready"
  | "degraded"
  | "failed"
  | "disconnected"
  | "unsupported";

export type DisplayState =
  /** No connection row exists yet. */
  | "NOT_CONNECTED"
  /** An action is in flight in THIS tab. Client-only, never persisted. */
  | "CONNECTING"
  /** The server answered 401 and wants an authorization that has not started. */
  | "AUTH_REQUIRED"
  /** An authorization URL was minted and the popup is open. */
  | "AUTHORIZING"
  | "CONNECTED"
  /** Connected, but listing its capabilities failed. NOT the same as "0 tools". */
  | "CAPABILITIES_UNAVAILABLE"
  /** A credential existed and stopped working: expired, revoked, refresh failed. */
  | "REAUTH_REQUIRED"
  /** Reachable problem — down, timing out, rate limited. Retry is meaningful. */
  | "UNAVAILABLE"
  /** The user closed it on purpose. Must never auto-reconnect. */
  | "DISCONNECTED"
  /** A local server this deployment's policy refuses to start. */
  | "BLOCKED"
  /** Not connectable here at all. */
  | "UNSUPPORTED";

export type StateInput = {
  /** Undefined when no `mcpConnections` row exists for this server. */
  status?: ConnectionStatus | null;
  lastErrorKind?: string | null;
  userActionRequired?: boolean | null;
  /** From `connections.listWithAuth`. Undefined when there is no connection. */
  auth?: Pick<CredentialStatus, "authState" | "updatedAt"> | null;
  /** For a local server: the validator's verdict, recomputed server-side. */
  localState?: "available" | "blocked" | null;
  /** An action this tab started and is waiting on. */
  busy?: boolean;
};

/** Did a credential row ever exist? `credentialStatusFor` returns a null
 *  `updatedAt` from exactly one branch — the one where it found no row — so
 *  this is the honest test for "auth means anything for this connection". */
function hasCredential(auth: StateInput["auth"]): boolean {
  return !!auth && auth.updatedAt !== null;
}

export function deriveState(input: StateInput): DisplayState {
  const {
    status,
    lastErrorKind,
    userActionRequired,
    auth,
    localState,
    busy,
  } = input;

  // 1. An in-flight action this tab owns. First because it is the only input
  //    that describes NOW rather than the last recorded outcome — without it a
  //    click would appear to do nothing until the action returns. It is not
  //    optimistic: "Connecting…" claims nothing about the result (§99).
  if (busy) return "CONNECTING";

  // 2. A local server the validator refuses. Outranks everything below,
  //    including a stale `ready` from before a policy ceiling changed: the
  //    verdict is recomputed on every read precisely so a row approved
  //    yesterday is not approved now.
  if (localState === "blocked") return "BLOCKED";

  // 3. No row: nothing has ever been attempted.
  if (!status) return "NOT_CONNECTED";

  // 4. TERMINAL, and they outrank the auth checks below on purpose. Somebody
  //    who deliberately disconnected must not be told to authenticate — that
  //    would present their own action back to them as a problem to fix.
  if (status === "unsupported") return "UNSUPPORTED";
  if (status === "disconnected") return "DISCONNECTED";

  // 5. What the SERVER said at runtime, which is the only authority on auth.
  //    `oauth.start` records `userActionRequired: true` with the error CLEARED,
  //    so the absence of a kind is what distinguishes "a URL is waiting for you"
  //    from "a 401 came back".
  if (userActionRequired) {
    if (lastErrorKind === "auth_failed") return "REAUTH_REQUIRED";
    if (lastErrorKind === "auth_required") return "AUTH_REQUIRED";
    return "AUTHORIZING";
  }

  // 6. A credential that exists and has stopped working. Guarded by
  //    `hasCredential` — see trap 1 in the module docstring.
  if (hasCredential(auth) && auth?.authState !== "CONNECTED") {
    // AUTHORIZATION_REQUIRED cannot reach here: a row exists, so
    // `credentialStatusFor` returned one of the four failure states instead.
    return "REAUTH_REQUIRED";
  }

  // 7. Connected, but its capability listing failed. Kept SEPARATE from
  //    CONNECTED so the summary can say "unavailable" instead of "0 tools" —
  //    the two mean opposite things to someone deciding whether to retry.
  if (status === "degraded") return "CAPABILITIES_UNAVAILABLE";
  if (status === "ready") return "CONNECTED";
  if (status === "failed") return "UNAVAILABLE";

  // 8. `configured`: a row exists and nothing has been contacted.
  return "NOT_CONNECTED";
}

/** States from which the user can start or resume a connection. */
const ACTIONABLE: ReadonlySet<DisplayState> = new Set<DisplayState>([
  "NOT_CONNECTED",
  "AUTH_REQUIRED",
  "AUTHORIZING",
  "REAUTH_REQUIRED",
  "UNAVAILABLE",
  "DISCONNECTED",
  "CAPABILITIES_UNAVAILABLE",
]);

/** Is there a primary action to offer?
 *
 *  BLOCKED and UNSUPPORTED are deliberately absent: a button that cannot work
 *  is worse than no button, and §38 forbids offering "Run anyway" as the way
 *  past a policy refusal. */
export function isActionable(state: DisplayState): boolean {
  return ACTIONABLE.has(state);
}

/** Does the connection currently contribute tools to a chat turn?
 *
 *  TRUE ONLY FOR `ready`, because that is literally what `dispatchPayload`
 *  filters on (`chat/stream.ts`). Anything looser here would tell a user their
 *  server is in play when the turn will not carry it. */
export function isLiveInChat(input: StateInput): boolean {
  return input.status === "ready";
}

/**
 * Should a capability COUNT be rendered, or the word "unavailable"?
 *
 * §101: `0 tools` and `tools unavailable` are different facts, and defaulting a
 * missing count to zero silently turns the second into the first. A count is
 * shown only when discovery actually completed — `capabilitiesAt` is the
 * timestamp `recordOutcome` writes alongside the snapshot, so its absence means
 * discovery never returned, not that the server offers nothing.
 */
export function hasCapabilityCounts(conn: {
  capabilitiesAt?: number | null;
  status?: ConnectionStatus | null;
}): boolean {
  return (
    conn.capabilitiesAt !== undefined &&
    conn.capabilitiesAt !== null &&
    conn.status !== "degraded"
  );
}
