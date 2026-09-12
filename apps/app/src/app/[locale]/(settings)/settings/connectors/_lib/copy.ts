import type { DisplayState } from "./state";

/**
 * Every user-facing string for Connectors, in one file.
 *
 * WHY NOT THE i18n LAYER. The app has locale-prefixed routing and
 * `next-international` wired, but adoption is two files out of a hundred and
 * seven: `en.ts` is 829 bytes covering the avatar and delete-account on the
 * Profile page, and every other surface — chat, projects, scheduled, skills,
 * memories, and the settings sidebar's own labels — hardcodes English. Adding
 * an `mcp` namespace here would make this the only translated feature in the
 * product and guarantee the other two locales drift on the day it ships.
 *
 * So the strings match the surrounding code, and they are COLLECTED HERE rather
 * than scattered through components — which is the part that matters for a
 * future i18n pass, because it leaves one file to lift instead of a dozen.
 *
 * THE VOCABULARY IS FIXED (§181). Connect · Connected · Reconnect · Disconnect ·
 * Authentication required · Temporarily unavailable · Not available here. No
 * synonyms: "Enable", "Link", "Add" and "Activate" are all absent on purpose,
 * because a user who learns one word for an action should not meet a second.
 */

type Presentation = {
  /** The status text. Never the only signal — see `glyph`. */
  label: string;
  /** A non-colour indicator, so status survives colour-blindness and greyscale
   *  (§123). Rendered aria-hidden beside the label, which carries the meaning. */
  glyph: string;
  /** The primary button, or null when there is nothing honest to offer. */
  action: string | null;
  /** One sentence under the label. Plain, never protocol vocabulary. */
  hint: string;
  /** Semantic tone. Maps to tokens in the component, never to a literal colour. */
  tone: "neutral" | "good" | "warn" | "bad";
};

export const STATE: Record<DisplayState, Presentation> = {
  NOT_CONNECTED: {
    label: "Not connected",
    glyph: "○",
    action: "Connect",
    hint: "Connect this app to let OllaSuper use it in chat.",
    tone: "neutral",
  },
  CONNECTING: {
    label: "Connecting…",
    glyph: "◌",
    action: null,
    hint: "Contacting the server.",
    tone: "neutral",
  },
  AUTH_REQUIRED: {
    label: "Authentication required",
    glyph: "!",
    action: "Connect",
    hint: "This app needs you to sign in and grant access.",
    tone: "warn",
  },
  AUTHORIZING: {
    label: "Waiting for authorization",
    glyph: "◌",
    // Not "Connect" again: the flow has started and the user is being asked to
    // return to a window that is already open.
    action: "Open authorization page",
    hint: "Finish signing in on the page that opened, then come back.",
    tone: "warn",
  },
  CONNECTED: {
    label: "Connected",
    glyph: "●",
    action: null,
    hint: "OllaSuper can use this app's tools when a request needs them.",
    tone: "good",
  },
  CAPABILITIES_UNAVAILABLE: {
    label: "Connected · capabilities unavailable",
    glyph: "◐",
    action: "Retry",
    // Deliberately explicit that this is NOT "this app offers nothing" — §44.
    hint: "Connected, but OllaSuper could not list what this app offers.",
    tone: "warn",
  },
  REAUTH_REQUIRED: {
    label: "Authentication required",
    glyph: "!",
    // §41: reconnect, never "delete and add again".
    action: "Reconnect",
    hint: "Your access to this app expired or was withdrawn.",
    tone: "warn",
  },
  UNAVAILABLE: {
    label: "Temporarily unavailable",
    glyph: "×",
    action: "Retry",
    // §43: the server's problem, stated as such.
    hint: "This app could not be reached just now.",
    tone: "bad",
  },
  DISCONNECTED: {
    label: "Disconnected",
    glyph: "○",
    action: "Reconnect",
    hint: "You disconnected this app. It stays off until you reconnect it.",
    tone: "neutral",
  },
  BLOCKED: {
    label: "Local use unavailable",
    glyph: "×",
    // §38: no "Run anyway". There is no honest action here.
    action: null,
    // §52/§36: a human state, never the security policy behind it.
    hint: "This app doesn't meet OllaSuper's requirements for running locally.",
    tone: "bad",
  },
  UNSUPPORTED: {
    label: "Not available here",
    glyph: "×",
    action: null,
    hint: "This app isn't available on this deployment.",
    tone: "neutral",
  },
};

/** Page-level copy. */
export const PAGE = {
  title: "Connectors",
  subtitle:
    "Connect apps so OllaSuper can use their tools while answering you.",
  searchPlaceholder: "Search connectors",
  yourConnections: "Your connections",
  browse: "Browse",
  // §182: one sentence of education, not a protocol lesson.
  about:
    "Connected apps can provide tools that OllaSuper may use to complete tasks. " +
    "Actions that change something still ask you first.",
  localAbout: "Runs locally on this deployment rather than over the internet.",
} as const;

/** Empty states (§54). Each says what to do, not what is missing. */
export const EMPTY = {
  /** The whole feature is switched off for this deployment. Distinct from
   *  "none curated" because only one of the two could ever change for the user,
   *  and neither has a retry. */
  disabled: {
    title: "Connectors aren't available here",
    body: "This deployment hasn't turned on connectors.",
  },
  catalogue: {
    title: "No connectors available",
    body: "This deployment has no connectors enabled yet.",
  },
  search: {
    title: "No matches",
    body: "No connector matches that search.",
  },
  connections: {
    title: "Nothing connected yet",
    body: "Connect an app below and its tools become available in chat.",
  },
  tools: { title: "No tools", body: "This app provides no tools." },
  resources: { title: "No resources", body: "This app provides no resources." },
  prompts: { title: "No prompts", body: "This app provides no prompts." },
} as const;

/** Error states (§55). Every one has a recovery action, never a bare "OK". */
export const ERROR = {
  catalogue: {
    title: "Couldn't load connectors",
    body: "The connector list is unavailable right now.",
    action: "Retry",
  },
  capabilities: {
    title: "Couldn't load capabilities",
    // §44: separated from "offers nothing" in words as well as in state.
    body: "Connected, but OllaSuper could not list what this app offers.",
    action: "Retry",
  },
  popupBlocked: {
    title: "Your browser blocked the sign-in window",
    body: "Open the authorization page to continue.",
    action: "Open authorization page",
  },
} as const;

/** Confirmations (§40, §124). Says exactly what it does and what it does not. */
export const CONFIRM = {
  disconnect: {
    title: "Disconnect this app?",
    // The sentence that stops a user believing their provider account is being
    // deleted. It is not, and only OllaSuper's access is withdrawn.
    description:
      "OllaSuper will stop using this app and will remove its stored access. " +
      "Your account with the app itself is not changed. You can reconnect later.",
    confirm: "Disconnect",
  },
} as const;

/** Category labels. Presentation lives here, availability comes from the
 *  server — the rule `explore-menu.tsx` already documents. An unknown category
 *  falls back to its own raw value rather than vanishing. */
export const CATEGORY: Record<string, string> = {
  productivity: "Productivity",
  communication: "Communication",
  developer: "Developer",
  documents: "Documents",
  research: "Research",
  browser: "Browser",
  business: "Business",
  finance: "Finance",
  travel: "Travel",
  calendar: "Calendar",
  email: "Email",
  other: "Other",
};

export function categoryLabel(raw: string): string {
  return CATEGORY[raw] ?? raw;
}
