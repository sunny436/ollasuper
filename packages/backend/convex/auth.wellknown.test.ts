/**
 * The OIDC discovery + JWKS routes are served by http.ts (not the library) so
 * their cache lifetime is ours. These pin what MUST NOT change — the bodies —
 * and what may: the `Cache-Control` value, driven by AUTH_WELLKNOWN_MAX_AGE_S.
 */
import { convexTest } from "convex-test";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

beforeAll(async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  process.env.SITE_URL = "http://localhost:3000";
  process.env.CONVEX_SITE_URL = "http://localhost:3211";
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(keys.privateKey);
  process.env.JWKS = JSON.stringify({ keys: [await exportJWK(keys.publicKey)] });
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: the var must be absent, not "undefined"
  delete process.env.AUTH_WELLKNOWN_MAX_AGE_S;
});

describe("well-known auth routes", () => {
  // First fetch in the file pays the cold module load (>30 s on Windows).
  test("jwks.json body is exactly the JWKS env, cached for an hour by default", { timeout: 180_000 }, async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(process.env.JWKS);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=3600, stale-while-revalidate=300, stale-if-error=86400",
    );
  });

  test("openid-configuration body matches what the library served", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/.well-known/openid-configuration");
    expect(res.status).toBe(200);
    // Same three fields, same values, same key order as
    // @convex-dev/auth/dist/server/implementation/index.js addHttpRoutes.
    expect(await res.text()).toBe(
      JSON.stringify({
        issuer: "http://localhost:3211",
        jwks_uri: "http://localhost:3211/.well-known/jwks.json",
        authorization_endpoint: "http://localhost:3211/oauth/authorize",
      }),
    );
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
  });

  test("AUTH_WELLKNOWN_MAX_AGE_S is a runtime knob (15 restores the library default)", async () => {
    process.env.AUTH_WELLKNOWN_MAX_AGE_S = "15";
    const t = convexTest(schema, modules);
    const res = await t.fetch("/.well-known/jwks.json");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=15, stale-while-revalidate=300, stale-if-error=86400",
    );
  });

  test("a garbage knob falls back to the default rather than serving max-age=NaN", async () => {
    process.env.AUTH_WELLKNOWN_MAX_AGE_S = "soon";
    const t = convexTest(schema, modules);
    const res = await t.fetch("/.well-known/jwks.json");
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
  });

  test("the library's other routes are still registered (the shim only drops the two)", async () => {
    const t = convexTest(schema, modules);
    // An unknown provider on the library's signin prefix route is handled by the
    // library (not a router 404): any status but 404 proves the route exists.
    const res = await t.fetch("/api/auth/signin/nope", { method: "GET" });
    expect(res.status).not.toBe(404);
  });
});
