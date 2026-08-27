/**
 * Phase 4 — Google OAuth + property-listing HTTP helpers (the only place the
 * connector talks to Google). Plain async functions (they `fetch`), imported by the
 * callback httpAction and the connector actions. Mutations/queries import the types
 * but never call these.
 *
 * SECURITY: these functions NEVER log a token, code, id_token, or a decrypted value.
 * On any non-2xx they throw a generic error carrying only a status, never the body.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GSC_SITES_URL = "https://www.googleapis.com/webmasters/v3/sites";
const GA4_ACCOUNT_SUMMARIES_URL =
  "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200";

export const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
];
const OAUTH_SCOPE = ["openid", "email", ...REQUIRED_SCOPES].join(" ");

export class GoogleOAuthError extends Error {
  constructor(
    public readonly reason: string,
    public readonly status = 0,
  ) {
    super(`google oauth error: ${reason}`);
    this.name = "GoogleOAuthError";
  }
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Read the connector OAuth client config; hard-fail at the call site (the vars are
 *  OPTIONAL in env.ts so the live backend doesn't fail VALIDATE_ENV before setup). */
export function googleConfig(): GoogleConfig {
  const clientId = process.env.CONNECTOR_GOOGLE_ID;
  const clientSecret = process.env.CONNECTOR_GOOGLE_SECRET;
  const redirectUri = process.env.CONNECTOR_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleOAuthError("connector client not configured");
  }
  return { clientId, clientSecret, redirectUri };
}

export function isConfigured(): boolean {
  return Boolean(
    process.env.CONNECTOR_GOOGLE_ID &&
      process.env.CONNECTOR_GOOGLE_SECRET &&
      process.env.CONNECTOR_REDIRECT_URI,
  );
}

/** Build the Google authorize URL. `redirect_uri` is the hardcoded configured
 *  constant — NEVER derived from a request (host-header spoofing defense). */
export function buildAuthorizeUrl(args: {
  state: string;
  codeChallenge: string;
  nonce: string;
}): string {
  const { clientId, redirectUri } = googleConfig();
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPE,
    access_type: "offline", // required to receive a refresh token
    prompt: "consent", // reliably re-issues a refresh token on reconnect
    include_granted_scopes: "true",
    state: args.state,
    nonce: args.nonce,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${p.toString()}`;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInS: number;
  grantedScopes: string[];
  idToken?: string;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    throw new GoogleOAuthError("token endpoint unreachable");
  }
  if (!res.ok) {
    // Read the error CODE only (invalid_grant matters), never log the full body.
    let code = "token_exchange_failed";
    try {
      const j = (await res.json()) as { error?: string };
      if (j && typeof j.error === "string") code = j.error;
    } catch {
      /* ignore */
    }
    throw new GoogleOAuthError(code, res.status);
  }
  const j = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    id_token?: string;
  };
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresInS: j.expires_in,
    grantedScopes: (j.scope ?? "").split(" ").filter(Boolean),
    idToken: j.id_token,
  };
}

export function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  const { clientId, clientSecret, redirectUri } = googleConfig();
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  );
}

export function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = googleConfig();
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  );
}

/** Revoke a token at Google (best-effort). Returns true on 200. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface IdTokenClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
}

/** Validate + extract the id_token claims. The token came straight from Google's
 *  token endpoint over TLS, so signature verification is not required (trusted
 *  channel); the CLAIMS still must be validated: iss, aud, exp, email_verified,
 *  nonce. Throws GoogleOAuthError on any mismatch. */
export function validateIdToken(idToken: string, expectedNonce: string): IdTokenClaims {
  const { clientId } = googleConfig();
  const parts = idToken.split(".");
  const payloadB64 = parts[1];
  if (parts.length !== 3 || !payloadB64) {
    throw new GoogleOAuthError("malformed id_token");
  }
  let claims: Record<string, unknown>;
  try {
    const b64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    claims = JSON.parse(atob(b64));
  } catch {
    throw new GoogleOAuthError("unparsable id_token");
  }
  const iss = String(claims.iss ?? "");
  if (iss !== "accounts.google.com" && iss !== "https://accounts.google.com") {
    throw new GoogleOAuthError("bad id_token iss");
  }
  if (String(claims.aud ?? "") !== clientId) {
    throw new GoogleOAuthError("bad id_token aud");
  }
  const exp = Number(claims.exp ?? 0);
  if (!exp || exp * 1000 < Date.now() - 60_000) {
    throw new GoogleOAuthError("expired id_token");
  }
  if (String(claims.nonce ?? "") !== expectedNonce) {
    throw new GoogleOAuthError("id_token nonce mismatch");
  }
  if (claims.email_verified !== true) {
    throw new GoogleOAuthError("email not verified");
  }
  return {
    sub: String(claims.sub ?? ""),
    email: String(claims.email ?? ""),
    emailVerified: true,
  };
}

async function getJson(url: string, accessToken: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new GoogleOAuthError("google api unreachable");
  }
  if (!res.ok) throw new GoogleOAuthError("google api error", res.status);
  return res.json();
}

export interface DiscoveredProperty {
  kind: "gsc_site" | "ga4_property";
  propertyId: string;
  displayName: string;
  permission: string;
}

/** List the GSC sites the connected user can access (Search Console). */
export async function fetchGscSites(accessToken: string): Promise<DiscoveredProperty[]> {
  const data = (await getJson(GSC_SITES_URL, accessToken)) as {
    siteEntry?: { siteUrl?: string; permissionLevel?: string }[];
  };
  return (data.siteEntry ?? [])
    .filter((s) => s.siteUrl)
    .map((s) => ({
      kind: "gsc_site" as const,
      propertyId: String(s.siteUrl),
      displayName: String(s.siteUrl),
      permission: String(s.permissionLevel ?? "unknown"),
    }));
}

/** List the GA4 properties via the Admin API accountSummaries. */
export async function fetchGa4Properties(
  accessToken: string,
): Promise<DiscoveredProperty[]> {
  const data = (await getJson(GA4_ACCOUNT_SUMMARIES_URL, accessToken)) as {
    accountSummaries?: {
      displayName?: string;
      propertySummaries?: { property?: string; displayName?: string }[];
    }[];
  };
  const out: DiscoveredProperty[] = [];
  for (const acct of data.accountSummaries ?? []) {
    for (const p of acct.propertySummaries ?? []) {
      if (!p.property) continue;
      // property is "properties/123456789" → keep the numeric id.
      const id = String(p.property).replace(/^properties\//, "");
      out.push({
        kind: "ga4_property",
        propertyId: id,
        displayName: `${p.displayName ?? id} · ${acct.displayName ?? ""}`.trim(),
        permission: "read",
      });
    }
  }
  return out;
}
