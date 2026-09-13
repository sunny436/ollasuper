import { describe, expect, test } from "bun:test";
import {
  type ConnectionStatus,
  type DisplayState,
  type StateInput,
  deriveState,
  hasCapabilityCounts,
  isActionable,
  isLiveInChat,
} from "./state";

/**
 * The connection state machine, exhaustively.
 *
 * WHY THE CROSS PRODUCT AND NOT A HANDFUL OF CASES. The inputs are independent
 * axes that the backend allows to disagree, and the two bugs this file exists
 * to prevent both live in combinations nobody would think to write down by
 * hand: a working no-auth server reporting AUTHORIZATION_REQUIRED, and a
 * deliberately disconnected connection being told to authenticate. So the whole
 * space is enumerated and every cell must land somewhere defensible.
 */

const STATUSES: ConnectionStatus[] = [
  "configured",
  "ready",
  "degraded",
  "failed",
  "disconnected",
  "unsupported",
];

const AUTH_STATES = [
  "AUTHORIZATION_REQUIRED",
  "REVOKED",
  "REAUTHORIZATION_REQUIRED",
  "TOKEN_EXPIRED",
  "CONNECTED",
] as const;

const ERROR_KINDS = [
  null,
  "auth_required",
  "auth_failed",
  "timeout",
  "unreachable",
  "rate_limited",
] as const;

/** No credential row: `credentialStatusFor`'s `if (!row)` branch, verbatim. */
const NO_CREDENTIAL = {
  authState: "AUTHORIZATION_REQUIRED",
  updatedAt: null,
} as const;

const withCredential = (authState: (typeof AUTH_STATES)[number]) => ({
  authState,
  updatedAt: 1_700_000_000_000,
});

// ======================================================== the two real traps
describe("the no-credential trap", () => {
  test("a working no-auth server is CONNECTED, not AUTH_REQUIRED", () => {
    // THE BUG THIS FILE EXISTS FOR. A server with authKind "none" stores no
    // credential, so `credentialStatusFor` returns AUTHORIZATION_REQUIRED from
    // its no-row branch — while the connection is perfectly healthy. Reading
    // authState without checking `updatedAt` renders "Authentication required"
    // over a server that needs none.
    expect(
      deriveState({ status: "ready", auth: NO_CREDENTIAL }),
    ).toBe("CONNECTED");
  });

  test("but a credential that EXISTS and is expired does mean reauth", () => {
    expect(
      deriveState({ status: "ready", auth: withCredential("TOKEN_EXPIRED") }),
    ).toBe("REAUTH_REQUIRED");
  });

  test("`updatedAt` is the whole discriminator, nothing else differs", () => {
    const expired = { authState: "TOKEN_EXPIRED" } as const;
    expect(
      deriveState({ status: "ready", auth: { ...expired, updatedAt: null } }),
    ).toBe("CONNECTED");
    expect(
      deriveState({ status: "ready", auth: { ...expired, updatedAt: 1 } }),
    ).toBe("REAUTH_REQUIRED");
  });

  test("`updatedAt: 0` counts as a credential, not as absent", () => {
    // A falsy-but-present timestamp. `!auth.updatedAt` would be wrong here and
    // would silently re-open the trap above.
    expect(
      deriveState({
        status: "ready",
        auth: { authState: "REVOKED", updatedAt: 0 },
      }),
    ).toBe("REAUTH_REQUIRED");
  });
});

describe("the clock-alone disagreement (ready + TOKEN_EXPIRED)", () => {
  test("is reachable and resolves to REAUTH_REQUIRED, never to two states", () => {
    // Nothing rewrites `status` when a token expires, so this pair happens on
    // its own with no failure anywhere. §189.
    const state = deriveState({
      status: "ready",
      auth: withCredential("TOKEN_EXPIRED"),
    });
    expect(state).toBe("REAUTH_REQUIRED");
    expect(state).not.toBe("CONNECTED");
  });
});

// ==================================================== terminal state precedence
describe("terminal states outrank auth", () => {
  test("a deliberately disconnected connection is never told to authenticate", () => {
    // Presenting the user's own action back to them as a problem to fix.
    for (const authState of AUTH_STATES) {
      expect(
        deriveState({
          status: "disconnected",
          auth: withCredential(authState),
          userActionRequired: true,
          lastErrorKind: "auth_required",
        }),
      ).toBe("DISCONNECTED");
    }
  });

  test("unsupported outranks every auth signal too", () => {
    expect(
      deriveState({
        status: "unsupported",
        auth: withCredential("TOKEN_EXPIRED"),
        userActionRequired: true,
        lastErrorKind: "auth_failed",
      }),
    ).toBe("UNSUPPORTED");
  });

  test("a blocked local server outranks even a stale `ready`", () => {
    // The validator's verdict is recomputed on every read exactly so a row
    // approved under old ceilings is not approved now.
    expect(
      deriveState({ status: "ready", localState: "blocked" }),
    ).toBe("BLOCKED");
  });

  test("busy outranks everything, because it describes NOW", () => {
    expect(
      deriveState({ status: "disconnected", busy: true }),
    ).toBe("CONNECTING");
  });
});

// ============================================================ the auth axis
describe("runtime auth signals, not authKind", () => {
  test("a 401 with no authorization started is AUTH_REQUIRED", () => {
    expect(
      deriveState({
        status: "configured",
        userActionRequired: true,
        lastErrorKind: "auth_required",
      }),
    ).toBe("AUTH_REQUIRED");
  });

  test("a rejected credential is REAUTH_REQUIRED", () => {
    expect(
      deriveState({
        status: "failed",
        userActionRequired: true,
        lastErrorKind: "auth_failed",
      }),
    ).toBe("REAUTH_REQUIRED");
  });

  test("userActionRequired with the error CLEARED is AUTHORIZING", () => {
    // `oauth.start` records exactly this: status configured, lastErrorKind
    // undefined, userActionRequired true. The absence of a kind is what says
    // "a URL is waiting for you" rather than "something failed".
    expect(
      deriveState({
        status: "configured",
        userActionRequired: true,
        lastErrorKind: null,
      }),
    ).toBe("AUTHORIZING");
  });
});

// ===================================================== capability honesty
describe("capabilities", () => {
  test("degraded is its own state, not CONNECTED", () => {
    expect(deriveState({ status: "degraded" })).toBe(
      "CAPABILITIES_UNAVAILABLE",
    );
  });

  test("a count is shown only when discovery actually completed", () => {
    expect(hasCapabilityCounts({ capabilitiesAt: 1, status: "ready" })).toBe(
      true,
    );
    // Never discovered: `0 tools` here would be a fabricated fact.
    expect(hasCapabilityCounts({ status: "ready" })).toBe(false);
    expect(
      hasCapabilityCounts({ capabilitiesAt: null, status: "ready" }),
    ).toBe(false);
    // Discovered once, failing now.
    expect(
      hasCapabilityCounts({ capabilitiesAt: 1, status: "degraded" }),
    ).toBe(false);
  });

  test("only `ready` contributes tools to a chat turn", () => {
    // Matches `dispatchPayload`'s filter exactly; anything looser would tell a
    // user their server is in play when the turn will not carry it.
    expect(isLiveInChat({ status: "ready" })).toBe(true);
    for (const status of STATUSES.filter((s) => s !== "ready")) {
      expect(isLiveInChat({ status })).toBe(false);
    }
  });
});

// ============================================================ exhaustive
describe("the full cross product", () => {
  const ALL: DisplayState[] = [
    "NOT_CONNECTED",
    "CONNECTING",
    "AUTH_REQUIRED",
    "AUTHORIZING",
    "CONNECTED",
    "CAPABILITIES_UNAVAILABLE",
    "REAUTH_REQUIRED",
    "UNAVAILABLE",
    "DISCONNECTED",
    "BLOCKED",
    "UNSUPPORTED",
  ];

  const inputs: StateInput[] = [];
  for (const status of [null, ...STATUSES]) {
    for (const lastErrorKind of ERROR_KINDS) {
      for (const userActionRequired of [false, true]) {
        for (const auth of [
          null,
          NO_CREDENTIAL,
          ...AUTH_STATES.map(withCredential),
        ]) {
          for (const localState of [null, "available", "blocked"] as const) {
            inputs.push({
              status,
              lastErrorKind,
              userActionRequired,
              auth,
              localState,
            });
          }
        }
      }
    }
  }

  test("every combination yields exactly one known state", () => {
    expect(inputs.length).toBe(7 * 6 * 2 * 7 * 3);
    for (const input of inputs) {
      const state = deriveState(input);
      expect(ALL).toContain(state);
    }
  });

  test("no input without a connection row ever reports CONNECTED", () => {
    // The one outcome that must be impossible to reach by accident: claiming a
    // live connection where no row exists.
    for (const input of inputs.filter((i) => !i.status)) {
      expect(deriveState(input)).not.toBe("CONNECTED");
    }
  });

  test("a disconnected row NEVER renders an auth state", () => {
    for (const input of inputs.filter((i) => i.status === "disconnected")) {
      const state = deriveState(input);
      expect(state === "AUTH_REQUIRED").toBe(false);
      expect(state === "REAUTH_REQUIRED").toBe(false);
      expect(state === "AUTHORIZING").toBe(false);
    }
  });

  test("a blocked local server is NEVER actionable", () => {
    // §38: no "Run anyway" past a policy refusal, by any route.
    for (const input of inputs.filter((i) => i.localState === "blocked")) {
      expect(isActionable(deriveState(input))).toBe(false);
    }
  });

  test("every state is either actionable or terminal, and the terminal set is closed", () => {
    const terminal = ALL.filter((s) => !isActionable(s));
    expect(terminal.sort()).toEqual(
      ["BLOCKED", "CONNECTED", "CONNECTING"].sort(),
    );
  });

  test("UNSUPPORTED is retryable but BLOCKED is not — found in production", () => {
    // A connection refused before its catalogue entry was complete stayed
    // stuck at `unsupported` afterwards with NO action at all, because the
    // state was treated as terminal. `unsupported` means the DEPLOYMENT could
    // not offer this server when it was last asked — not curated, not enabled,
    // no version row — and every one of those can change.
    //
    // Retrying re-asks a question only the server can answer, so it is not the
    // "Run anyway" §38 forbids. `BLOCKED` is a LOCAL POLICY verdict, where no
    // amount of retrying changes the answer, so it stays actionless.
    expect(isActionable("UNSUPPORTED")).toBe(true);
    expect(isActionable("BLOCKED")).toBe(false);
  });

  test("the reducer is pure — same input, same answer", () => {
    for (const input of inputs.slice(0, 200)) {
      expect(deriveState(input)).toBe(deriveState({ ...input }));
    }
  });
});
