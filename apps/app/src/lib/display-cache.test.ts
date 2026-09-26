import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// A minimal browser: display-cache.ts only touches window.localStorage.
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const {
  CACHE_KEYS,
  clearDisplayCaches,
  ownerFromToken,
  readOwnedCache,
  writeOwnedCache,
} = await import("./display-cache");

/** An unsigned JWT-shaped string — ownerFromToken only reads the claims. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
}

const inAnHour = Math.floor(Date.now() / 1000) + 3600;

beforeEach(() => store.clear());
// Other test files in this process expect NO window (server rendering).
afterAll(() => {
  // biome-ignore lint/performance/noDelete: the global must be absent again
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("owner-bound display caches (audit F-09)", () => {
  test("the owner is the user part of the JWT subject, and only while unexpired", () => {
    expect(ownerFromToken(jwt({ sub: "user1|sess1", exp: inAnHour }))).toBe("user1");
    expect(ownerFromToken(jwt({ sub: "user1|sess1", exp: 1 }))).toBeNull();
    expect(ownerFromToken(null)).toBeNull();
    expect(ownerFromToken("not-a-jwt")).toBeNull();
  });

  test("an account never reads another account's cache — and it is deleted on sight", () => {
    writeOwnedCache(CACHE_KEYS.threads, "alice", [{ title: "Alice's salary" }]);
    expect(readOwnedCache(CACHE_KEYS.threads, "bob")).toBeNull();
    expect(store.has(CACHE_KEYS.threads)).toBe(false);
  });

  test("signed out (no owner) reads nothing and writes nothing", () => {
    writeOwnedCache(CACHE_KEYS.user, "alice", { name: "Alice" });
    expect(readOwnedCache(CACHE_KEYS.user, null)).toBeNull();
    expect(writeOwnedCache(CACHE_KEYS.user, null, { name: "x" })).toBe(false);
    expect(store.has(CACHE_KEYS.user)).toBe(false);
  });

  test("a pre-envelope (legacy, unowned) entry is never shown", () => {
    store.set(CACHE_KEYS.transcript, JSON.stringify({ threadId: "t", msgs: ["x"] }));
    expect(readOwnedCache(CACHE_KEYS.transcript, "alice")).toBeNull();
    expect(store.has(CACHE_KEYS.transcript)).toBe(false);
  });

  test("a stale entry expires", () => {
    store.set(
      CACHE_KEYS.user,
      JSON.stringify({ owner: "alice", at: Date.now() - 2 * 86_400_000, v: {} }),
    );
    expect(readOwnedCache(CACHE_KEYS.user, "alice")).toBeNull();
  });

  test("the owner still gets their own fresh cache (the reload paint is kept)", () => {
    writeOwnedCache(CACHE_KEYS.user, "alice", { name: "Alice" });
    expect(readOwnedCache(CACHE_KEYS.user, "alice")).toEqual({ name: "Alice" });
  });

  test("an oversized entry is dropped rather than written", () => {
    expect(writeOwnedCache(CACHE_KEYS.transcript, "alice", "x".repeat(200), 50)).toBe(
      false,
    );
    expect(store.has(CACHE_KEYS.transcript)).toBe(false);
  });

  test("clearDisplayCaches removes every key", () => {
    writeOwnedCache(CACHE_KEYS.user, "alice", {});
    writeOwnedCache(CACHE_KEYS.threads, "alice", []);
    writeOwnedCache(CACHE_KEYS.workspace, "alice", "ws_a");
    clearDisplayCaches();
    expect(store.size).toBe(0);
  });
});

describe("the remembered workspace is bound to its account", () => {
  // The next account on a browser used to start out on the previous account's
  // workspace, get "Forbidden" from every workspace query, and land on the
  // error page — every time for a new sign-up (reproduced on production).
  test("another account never starts on it, and it is dropped on sight", () => {
    writeOwnedCache(CACHE_KEYS.workspace, "alice", "ws_alice");
    expect(readOwnedCache(CACHE_KEYS.workspace, "bob")).toBeNull();
    expect(store.has(CACHE_KEYS.workspace)).toBe(false);
  });

  test("the pre-fix bare id (no owner) is never trusted", () => {
    store.set(CACHE_KEYS.workspace, "ws_from_whoever");
    expect(readOwnedCache(CACHE_KEYS.workspace, "bob")).toBeNull();
  });

  test("its own account still gets it back (no 'Preparing' flash on reload)", () => {
    writeOwnedCache(CACHE_KEYS.workspace, "alice", "ws_alice");
    expect(readOwnedCache(CACHE_KEYS.workspace, "alice")).toBe("ws_alice");
  });
});
