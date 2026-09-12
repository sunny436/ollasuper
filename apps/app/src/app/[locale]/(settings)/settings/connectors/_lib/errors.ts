/**
 * Backend outcomes -> something a person can act on.
 *
 * WHAT THE BACKEND ALREADY DID, so this layer does not redo it. The Python
 * plane classifies every failure into an `McpErrorKind` and bounds its detail
 * to a sentence; Convex `clamp`s that to 400 characters and strips control
 * characters. Nothing here is a sanitiser — by the time a string arrives it has
 * been through both. What is missing is only the last step: a kind is a wire
 * value, and `session_expired` is not a sentence anyone should read.
 *
 * WHY A MAP AND NOT THE SERVER'S DETAIL. The detail is accurate and specific
 * ("the AI service answered 502"), which is exactly wrong for a primary
 * message: it describes OllaSuper's internals to someone who wants to know
 * whether to press Retry. So the kind chooses the sentence, and the detail is
 * kept for the advanced view (§105) where it is genuinely useful.
 *
 * THE ABSENT ENTRIES ARE THE POINT. There is no branch that renders a stack
 * trace, a header, a URL or a provider's raw body, because no such value
 * reaches this file — `runOperation` and `callPlane` both refuse to echo an
 * exception, on the grounds that it can carry an internal hostname.
 */

/** The stable codes the UI reasons about (§162). Derived from `McpErrorKind`
 *  plus the two states Convex can produce on its own. */
export type ErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_FAILED"
  | "SERVER_UNAVAILABLE"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "NOT_SUPPORTED"
  | "CAPABILITY_DISCOVERY_FAILED"
  | "NOT_CONFIGURED"
  | "UNKNOWN";

const BY_KIND: Record<string, ErrorCode> = {
  // --- the server answered ---
  auth_required: "AUTH_REQUIRED",
  auth_failed: "AUTH_FAILED",
  rate_limited: "RATE_LIMITED",
  server_error: "SERVER_UNAVAILABLE",
  session_expired: "SERVER_UNAVAILABLE",
  // --- reaching the server ---
  dns_failed: "SERVER_UNAVAILABLE",
  tls_failed: "SERVER_UNAVAILABLE",
  unreachable: "SERVER_UNAVAILABLE",
  timeout: "TIMEOUT",
  // --- refused before a packet left ---
  unsupported_transport: "NOT_SUPPORTED",
  endpoint_rejected: "NOT_SUPPORTED",
  // --- the server answered wrongly ---
  protocol_mismatch: "NOT_SUPPORTED",
  malformed_initialize: "NOT_SUPPORTED",
  capability_error: "CAPABILITY_DISCOVERY_FAILED",
};

const MESSAGE: Record<ErrorCode, string> = {
  AUTH_REQUIRED: "This app needs you to sign in and grant access.",
  AUTH_FAILED: "OllaSuper's access to this app is no longer valid.",
  // §43: "temporarily", and about the app rather than about the user.
  SERVER_UNAVAILABLE: "This app could not be reached just now.",
  TIMEOUT: "This app took too long to respond.",
  RATE_LIMITED: "This app is busy. Try again in a moment.",
  // §52: the requirement, never the policy behind it.
  NOT_SUPPORTED: "This app isn't available on this deployment.",
  CAPABILITY_DISCOVERY_FAILED:
    "Connected, but OllaSuper could not list what this app offers.",
  NOT_CONFIGURED: "Connectors aren't available on this deployment.",
  UNKNOWN: "Something went wrong. Try again.",
};

/** Codes a retry can plausibly fix. Mirrors the Python `_RETRYABLE` set rather
 *  than inventing a second opinion: offering Retry where the backend has
 *  already decided a human must act is how a user ends up clicking forever. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "SERVER_UNAVAILABLE",
  "TIMEOUT",
  "RATE_LIMITED",
  "CAPABILITY_DISCOVERY_FAILED",
]);

export type UiError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** The backend's own sentence, for an advanced/details view only (§105).
   *  Already bounded and classified upstream; null when there was none. */
  detail: string | null;
};

export function classify(
  kind: string | null | undefined,
  detail?: string | null,
): UiError {
  const code = (kind && BY_KIND[kind]) || "UNKNOWN";
  return {
    code,
    message: MESSAGE[code],
    retryable: RETRYABLE.has(code),
    detail: typeof detail === "string" && detail.length > 0 ? detail : null,
  };
}

/** The shape `connections.connect` / `oauth.*` hand back. Deliberately loose:
 *  these are `Record<string, unknown>` on the wire, and asserting a narrow type
 *  over them would be a lie the compiler cannot check. */
export type PlaneReport = Record<string, unknown>;

/** Read a report into a UiError, or null when it reported success.
 *
 *  `state === "ready"` and `auth_state === "CONNECTED"` are the two success
 *  shapes; everything else is surfaced. A report with NEITHER a state nor an
 *  error is treated as unknown rather than as success — failing towards "tell
 *  the user something happened" beats a silent no-op. */
export function fromReport(report: PlaneReport | null | undefined): UiError | null {
  if (!report) return classify(null, null);
  if (report.state === "ready") return null;
  if (report.auth_state === "CONNECTED") return null;

  const kind =
    typeof report.error_kind === "string" ? report.error_kind : null;
  const detail =
    typeof report.error_detail === "string"
      ? report.error_detail
      : typeof report.detail === "string"
        ? report.detail
        : null;

  // An `auth_state` of AUTHORIZATION_REQUIRED is not a failure — it is the flow
  // working. Only ERROR is.
  if (!kind && report.auth_state === "AUTHORIZING") return null;
  if (!kind && report.auth_state === "AUTHORIZATION_REQUIRED") {
    return classify("auth_required", detail);
  }
  return classify(kind, detail);
}
