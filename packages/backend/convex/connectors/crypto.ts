/**
 * Phase 4 — the connector token vault's encryption + OAuth-PKCE primitives.
 *
 * This is the FIRST encryption-at-rest primitive in the repo (everything else
 * hashes-and-discards). A connector must retain a RECOVERABLE secret (the Google
 * refresh token), so it is encrypted with AES-256-GCM (authenticated: a tampered
 * ciphertext fails `decrypt`, it doesn't silently return garbage).
 *
 * Ciphertext layout (then base64):  [ keyVersion(1) | iv(12) | ct+gcmTag ]
 * The 1-byte key version lets `CONNECTOR_ENC_KEY` rotate WITHOUT forcing every user
 * to reconnect: old ciphertexts still decrypt with the prior key while new ones use
 * the current key.
 *
 * `CONNECTOR_ENC_KEY` is base64 of 32 raw bytes. It is declared OPTIONAL in env.ts
 * (a required var would fail `VALIDATE_ENV` on the live backend the instant this code
 * lands, before the operator sets it) and hard-fails HERE at the call site.
 */

const CURRENT_KEY_VERSION = 1;

// --- base64 / base64url (binary-safe; tokens are small) --------------------
function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- key management (versioned, so the key can rotate) ---------------------
function rawKeyForVersion(version: number): Uint8Array {
  // v1 = the current key. A future rotation sets CONNECTOR_ENC_KEY to the new key
  // and keeps the old one under CONNECTOR_ENC_KEY_V<n> so its ciphertexts still open.
  const envName =
    version === CURRENT_KEY_VERSION
      ? "CONNECTOR_ENC_KEY"
      : `CONNECTOR_ENC_KEY_V${version}`;
  const b64 = process.env[envName];
  if (!b64) {
    throw new Error(`${envName} is not configured on the Convex deployment`);
  }
  const raw = fromB64(b64);
  if (raw.length !== 32) {
    throw new Error(`${envName} must decode to 32 bytes (got ${raw.length})`);
  }
  return raw;
}

const _keyCache = new Map<number, Promise<CryptoKey>>();
/** Test-only: drop the imported-key cache so a changed CONNECTOR_ENC_KEY is re-read. */
export function _clearForTest(): void {
  _keyCache.clear();
}
function keyForVersion(version: number): Promise<CryptoKey> {
  let k = _keyCache.get(version);
  if (!k) {
    k = crypto.subtle.importKey(
      "raw",
      rawKeyForVersion(version),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    _keyCache.set(version, k);
  }
  return k;
}

/** Raised when a stored secret cannot be decrypted (wrong/rotated/missing key or a
 *  tampered blob). Callers map this to `needs_reauth`, never a 500. */
export class UndecryptableError extends Error {
  constructor() {
    super("connector secret could not be decrypted");
    this.name = "UndecryptableError";
  }
}

/** Encrypt a plaintext secret → an opaque base64 blob (keyVersion‖iv‖ct+tag). */
export async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyForVersion(CURRENT_KEY_VERSION);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  const blob = new Uint8Array(1 + iv.length + ct.length);
  blob[0] = CURRENT_KEY_VERSION;
  blob.set(iv, 1);
  blob.set(ct, 1 + iv.length);
  return toB64(blob);
}

/** Decrypt a blob produced by `encryptSecret`. Throws `UndecryptableError` on any
 *  failure (wrong/rotated key, tampered ciphertext) — never returns garbage. */
export async function decryptSecret(blob: string): Promise<string> {
  try {
    const bytes = fromB64(blob);
    // getUint8 returns a number (throws RangeError on a too-short blob → caught).
    const version = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint8(0);
    const iv = bytes.slice(1, 13);
    const ct = bytes.slice(13);
    const key = await keyForVersion(version);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    throw new UndecryptableError();
  }
}

// --- OAuth 2.0 PKCE + CSRF primitives (all CSPRNG) -------------------------
/** A high-entropy value for `state` / `nonce` (default 32 bytes = 256 bits). */
export function randomToken(nBytes = 32): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(nBytes)));
}

/** RFC 7636 PKCE code verifier (43 chars, base64url of 32 random bytes). */
export function pkceVerifier(): string {
  return toB64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** RFC 7636 S256 code challenge = base64url(SHA-256(ASCII(verifier))). */
export async function challengeS256(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toB64Url(new Uint8Array(d));
}
