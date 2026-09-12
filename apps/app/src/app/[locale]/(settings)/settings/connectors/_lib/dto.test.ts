import { describe, expect, test } from "bun:test";
import { classify, fromReport } from "./errors";
import {
  type ConnectionRow,
  categoriesOf,
  externalLink,
  joinConnectors,
  searchConnectors,
  toView,
} from "./dto";

const SERVER = {
  serverName: "test.fixture/github",
  slug: "github",
  displayName: "GitHub",
  category: "developer",
  description: "Repositories, issues and pull requests.",
  authKind: "oauth",
  transport: "streamable-http",
  catalogueStatus: "active",
};

const ROW = (over: Partial<ConnectionRow> = {}): ConnectionRow => ({
  _id: "conn-1",
  serverName: "test.fixture/github",
  slug: "github",
  status: "ready",
  capabilitiesAt: 1_700_000_000_000,
  toolCount: 12,
  auth: {
    authState: "CONNECTED",
    scope: "repo read:user",
    expiresAt: null,
    updatedAt: 1_700_000_000_000,
  },
  ...over,
});

// ============================================================ the count rule
describe("capability counts never fabricate a zero", () => {
  test("a discovered count is shown", () => {
    expect(toView(SERVER, ROW()).toolCount).toBe(12);
  });

  test("a genuine zero is preserved, not treated as missing", () => {
    // The other half of §101: "0 tools" is a real, renderable fact when
    // discovery DID complete. Collapsing it to null would be the same lie in
    // the opposite direction.
    expect(toView(SERVER, ROW({ toolCount: 0 })).toolCount).toBe(0);
  });

  test("discovery that never completed is null, not 0", () => {
    const row = ROW();
    row.capabilitiesAt = undefined;
    expect(toView(SERVER, row).toolCount).toBeNull();
  });

  test("a degraded connection reports null even holding an old count", () => {
    // It discovered 12 once and cannot list them now. Showing 12 would claim a
    // present fact from a past one.
    expect(toView(SERVER, ROW({ status: "degraded" })).toolCount).toBeNull();
  });

  test("no connection at all is null", () => {
    expect(toView(SERVER, undefined).toolCount).toBeNull();
  });
});

// ================================================================= the join
describe("joining the catalogue to connections", () => {
  test("joins on serverName, not slug", () => {
    // Two catalogue entries sharing a slug must not collapse into one
    // connection. `mcpConnections` is keyed by (user, serverName), so that is
    // the only key that cannot be ambiguous.
    const other = { ...SERVER, serverName: "other.vendor/github", slug: "github" };
    const views = joinConnectors([SERVER, other], [ROW()]);
    expect(views[0]?.connected).toBe(true);
    expect(views[1]?.connected).toBe(false);
  });

  test("a connection whose server left the catalogue is not rendered", () => {
    // §113/§114: the ROW survives — de-curating a server is not deleting
    // somebody's connection — it simply has no card.
    const views = joinConnectors([], [ROW()]);
    expect(views).toHaveLength(0);
  });

  test("a null catalogue is an empty list, never a crash", () => {
    expect(joinConnectors(null, [ROW()])).toEqual([]);
    expect(joinConnectors(undefined, undefined)).toEqual([]);
  });

  test("busy is applied per server, so one slow row cannot freeze the page", () => {
    const views = joinConnectors([SERVER], [ROW()], {
      busy: new Set(["test.fixture/github"]),
    });
    expect(views[0]?.state).toBe("CONNECTING");
  });

  test("a local server is its own entry, NOT an annotation on a curated one", () => {
    // THE BUG THIS TEST EXISTS FOR. An earlier version matched local rows onto
    // curated rows by slug — which `validate_local_server` guarantees can never
    // match, because it REFUSES a slug already used by a curated remote server.
    // The local layer therefore did nothing at all and local servers were
    // invisible. They are a separate table and a separate decision, so they are
    // separate cards.
    const views = joinConnectors([SERVER], [], {
      local: [
        {
          slug: "fs-local",
          displayName: "Files",
          state: "available",
          network: "none",
          trust: "approved",
        },
      ],
    });
    expect(views).toHaveLength(2);
    const local = views.find((v) => v.slug === "fs-local");
    expect(local?.runtime).toBe("local");
    // `local/<slug>` is what `gateway_spec` mints and what an mcpConnections
    // row stores, so the connection join finds it with no special case.
    expect(local?.serverName).toBe("local/fs-local");
    expect(local?.authKind).toBe("none");
    // The curated entry is untouched.
    expect(views.find((v) => v.slug === "github")?.runtime).toBe("remote");
  });

  test("a local connection joins to its local card", () => {
    const views = joinConnectors([], [ROW({ serverName: "local/fs-local", slug: "fs-local" })], {
      local: [
        {
          slug: "fs-local",
          displayName: "Files",
          state: "available",
          network: "none",
          trust: "approved",
        },
      ],
    });
    expect(views[0]?.connected).toBe(true);
    expect(views[0]?.connectionId).toBe("conn-1");
  });

  test("a blocked local server renders BLOCKED even when connected", () => {
    // The validator's verdict is recomputed on every read precisely so a row
    // approved under old ceilings is not approved now.
    const views = joinConnectors([], [ROW({ serverName: "local/fs-local", slug: "fs-local" })], {
      local: [
        {
          slug: "fs-local",
          displayName: "Files",
          state: "blocked",
          network: "none",
          trust: "blocked",
        },
      ],
    });
    expect(views[0]?.state).toBe("BLOCKED");
  });

  test("a null catalogue still shows local servers", () => {
    // Local is an independent layer: a catalogue read that failed must not take
    // the local list down with it.
    const views = joinConnectors(null, [], {
      local: [
        {
          slug: "fs-local",
          displayName: "Files",
          state: "available",
          network: "none",
          trust: "approved",
        },
      ],
    });
    expect(views).toHaveLength(1);
  });
});

// =============================================================== no id leak
describe("what a view never carries", () => {
  test("the scope is exposed but no account identity is invented", () => {
    const view = toView(SERVER, ROW());
    expect(view.scope).toBe("repo read:user");
    // §22: the backend records no authorized principal, so there is no field
    // here for one. A view that grew `accountLabel` would have to fabricate it.
    expect("accountLabel" in view).toBe(false);
    expect("account" in view).toBe(false);
  });

  test("hasCredential is independent of scope", () => {
    // THE DISCONNECT DISCRIMINATOR. Only `oauth.disconnect` revokes at the
    // provider and deletes the stored credential; `connections.disconnect`
    // merely closes the session. A provider that issues a token and returns NO
    // scope is ordinary, so choosing the path on `scope` would leave that
    // credential in the vault — a secret outliving what it authorizes.
    const noScope = ROW();
    noScope.auth = {
      authState: "CONNECTED",
      scope: null,
      expiresAt: null,
      updatedAt: 1_700_000_000_000,
    };
    const view = toView(SERVER, noScope);
    expect(view.scope).toBeNull();
    expect(view.hasCredential).toBe(true);
  });

  test("hasCredential is false when no credential row exists", () => {
    const none = ROW();
    none.auth = {
      authState: "AUTHORIZATION_REQUIRED",
      scope: null,
      expiresAt: null,
      updatedAt: null,
    };
    expect(toView(SERVER, none).hasCredential).toBe(false);
    expect(toView(SERVER, undefined).hasCredential).toBe(false);
  });

  test("connectionId exists for wiring but is not a display field", () => {
    const view = toView(SERVER, ROW());
    expect(view.connectionId).toBe("conn-1");
    // The contract the components rely on: displayName is what gets rendered,
    // and it is never the id.
    expect(view.displayName).toBe("GitHub");
    expect(view.displayName).not.toContain("conn-1");
  });
});

// ================================================================== search
describe("search", () => {
  const views = joinConnectors(
    [
      SERVER,
      {
        ...SERVER,
        serverName: "test.fixture/gcal",
        slug: "gcal",
        displayName: "Google Calendar",
        category: "calendar",
        description: "Read and create events in your calendar.",
      },
    ],
    [],
  );

  test("finds by display name", () => {
    expect(searchConnectors(views, "calendar").map((v) => v.slug)).toEqual([
      "gcal",
    ]);
  });

  test("finds by what it DOES, not just by its name", () => {
    // "email"/"events" live in the description far more often than in a title.
    expect(searchConnectors(views, "events").map((v) => v.slug)).toEqual([
      "gcal",
    ]);
  });

  test("finds by category label as well as raw category", () => {
    expect(searchConnectors(views, "Developer").map((v) => v.slug)).toEqual([
      "github",
    ]);
  });

  test("is case and whitespace insensitive", () => {
    expect(searchConnectors(views, "  GITHUB ").map((v) => v.slug)).toEqual([
      "github",
    ]);
  });

  test("an empty query returns everything, not nothing", () => {
    expect(searchConnectors(views, "   ")).toHaveLength(2);
  });

  test("no match is an empty list, which the caller renders as a message", () => {
    expect(searchConnectors(views, "zzzz")).toHaveLength(0);
  });

  test("categories come from the data, so no empty filter is offered", () => {
    expect(categoriesOf(views)).toEqual(["calendar", "developer"]);
  });
});

// ============================================================ url safety
describe("external links", () => {
  test("javascript: and data: are refused", () => {
    expect(externalLink("javascript:alert(1)")).toBeNull();
    expect(externalLink("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(externalLink("vbscript:msgbox(1)")).toBeNull();
  });

  test("plain http is refused too, not merely downgraded", () => {
    // Third-party metadata is not a good enough reason to send someone to a
    // plaintext page.
    expect(externalLink("http://example.com")).toBeNull();
  });

  test("https passes", () => {
    expect(externalLink("https://example.com/docs")).toBe(
      "https://example.com/docs",
    );
  });

  test("empty and nullish are null, never undefined-shaped output", () => {
    expect(externalLink("")).toBeNull();
    expect(externalLink(null)).toBeNull();
    expect(externalLink(undefined)).toBeNull();
  });

  test("obfuscated schemes are refused", () => {
    // The shared guard normalises before testing; asserted here so a change to
    // it that weakened this shows up in THIS feature's tests too.
    expect(externalLink("  JaVaScRiPt:alert(1)")).toBeNull();
    expect(externalLink("java\nscript:alert(1)")).toBeNull();
  });
});

// ============================================================ error mapping
describe("error classification", () => {
  test("every kind the backend can emit has a human sentence", () => {
    const KINDS = [
      "unsupported_transport",
      "endpoint_rejected",
      "dns_failed",
      "tls_failed",
      "unreachable",
      "timeout",
      "auth_required",
      "auth_failed",
      "rate_limited",
      "server_error",
      "session_expired",
      "protocol_mismatch",
      "malformed_initialize",
      "capability_error",
    ];
    for (const kind of KINDS) {
      const e = classify(kind, null);
      expect(e.code).not.toBe("UNKNOWN");
      expect(e.message.length).toBeGreaterThan(0);
      // No wire vocabulary reaches the user.
      expect(e.message).not.toContain("_");
    }
  });

  test("an unknown kind degrades to a usable message, not to a blank", () => {
    const e = classify("something_new_in_a_later_phase", null);
    expect(e.code).toBe("UNKNOWN");
    expect(e.message).toBe("Something went wrong. Try again.");
  });

  test("retryable matches the backend's own opinion", () => {
    expect(classify("timeout").retryable).toBe(true);
    expect(classify("rate_limited").retryable).toBe(true);
    expect(classify("unreachable").retryable).toBe(true);
    // A human must act on these; offering Retry would be an endless button.
    expect(classify("auth_required").retryable).toBe(false);
    expect(classify("auth_failed").retryable).toBe(false);
    expect(classify("unsupported_transport").retryable).toBe(false);
  });

  test("the detail is kept separate from the message", () => {
    const e = classify("server_error", "the AI service answered 502");
    expect(e.message).toBe("This app could not be reached just now.");
    // §105: available for an advanced view, never the primary sentence.
    expect(e.detail).toBe("the AI service answered 502");
  });

  test("a ready report is not an error", () => {
    expect(fromReport({ state: "ready", tool_count: 3 })).toBeNull();
  });

  test("an AUTHORIZING report is the flow working, not a failure", () => {
    expect(
      fromReport({ auth_state: "AUTHORIZING", authorization_url: "https://x" }),
    ).toBeNull();
  });

  test("a failed report is classified from its kind", () => {
    const e = fromReport({
      state: "failed",
      error_kind: "auth_required",
      error_detail: "the server requires authorization",
    });
    expect(e?.code).toBe("AUTH_REQUIRED");
  });

  test("a missing report is an error, not a silent success", () => {
    // Failing towards "tell the user something happened" beats a no-op.
    expect(fromReport(null)?.code).toBe("UNKNOWN");
    expect(fromReport(undefined)?.code).toBe("UNKNOWN");
  });

  test("a report with no state and no kind is unknown, not success", () => {
    expect(fromReport({})?.code).toBe("UNKNOWN");
  });
});
