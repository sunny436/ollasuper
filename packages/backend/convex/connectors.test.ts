/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  _clearForTest,
  challengeS256,
  decryptSecret,
  encryptSecret,
  pkceVerifier,
  randomToken,
  UndecryptableError,
} from "./connectors/crypto";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
type TestT = TestConvex<typeof schema>;
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

// A deterministic 32-byte base64 key for the tests.
const KEY = btoa(String.fromCharCode(...new Array(32).fill(42)));
const CLIENT_ID = "test-connector-client.apps.googleusercontent.com";
const INGRESS = "test-ingress-secret-0123456789ab";

describe("connector crypto — AES-256-GCM vault (the Phase-4 gate)", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.CONNECTOR_ENC_KEY;
    process.env.CONNECTOR_ENC_KEY = KEY;
  });
  afterEach(() => {
    if (prev === undefined) {
      // biome-ignore lint/performance/noDelete: the only way to unset an env var
      delete process.env.CONNECTOR_ENC_KEY;
    } else {
      process.env.CONNECTOR_ENC_KEY = prev;
    }
  });

  test("encrypt → decrypt round-trips a secret (AES-GCM is available in the runtime)", async () => {
    const secret = "1//refresh-token-abc.DEF_ghi-123";
    const blob = await encryptSecret(secret);
    // Ciphertext at rest is NOT the plaintext.
    expect(blob).not.toContain("refresh-token");
    expect(blob).not.toEqual(secret);
    expect(await decryptSecret(blob)).toBe(secret);
  });

  test("each encryption uses a fresh IV (same plaintext ⇒ different ciphertext)", async () => {
    const a = await encryptSecret("same");
    const b = await encryptSecret("same");
    expect(a).not.toEqual(b);
    expect(await decryptSecret(a)).toBe("same");
    expect(await decryptSecret(b)).toBe("same");
  });

  test("a tampered ciphertext is rejected (GCM tag), never silently wrong", async () => {
    const blob = await encryptSecret("token");
    // Flip a byte in the base64 body.
    const bad = blob.slice(0, -4) + (blob.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    await expect(decryptSecret(bad)).rejects.toBeInstanceOf(UndecryptableError);
  });

  test("a blob whose key version is gone (rotated away) fails ⇒ needs_reauth", async () => {
    const blob = await encryptSecret("token");
    // Rewrite the 1-byte key-version prefix to an unconfigured version.
    const raw = atob(blob);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    arr[0] = 2; // CONNECTOR_ENC_KEY_V2 is not set → key lookup throws → wrapped
    let s = "";
    for (const b of arr) s += String.fromCharCode(b);
    await expect(decryptSecret(btoa(s))).rejects.toBeInstanceOf(UndecryptableError);
  });

  test("a missing CONNECTOR_ENC_KEY hard-fails at the call site (never silent)", async () => {
    // biome-ignore lint/performance/noDelete: the only way to unset an env var
    delete process.env.CONNECTOR_ENC_KEY;
    _clearForTest();
    await expect(encryptSecret("x")).rejects.toThrow(/CONNECTOR_ENC_KEY/);
  });
});

describe("connector crypto — OAuth PKCE + CSRF tokens", () => {
  test("S256 challenge matches the RFC 7636 Appendix B test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await challengeS256(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("verifier is base64url and unique per call", () => {
    const a = pkceVerifier();
    const b = pkceVerifier();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no +/=
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  test("randomToken is high-entropy base64url and unique", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(43); // 32 bytes → 43 base64url chars
  });
});
