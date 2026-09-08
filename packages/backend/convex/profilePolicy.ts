import { ConvexError } from "convex/values";
import { username as usernameSchema } from "./utils/validators";

/**
 * Identity rules for the profile surface.
 *
 * Kept beside authPolicy.ts (which owns EMAIL identity) rather than inside
 * users.ts, so the rules are testable without a database and there is exactly
 * one definition for every caller.
 */

/**
 * Names nobody may claim.
 *
 * The point is impersonation, not taste: `username` is what the sidebar and the
 * chat greeting render (getUser returns `username || name`), so a user holding
 * `admin` or `support` looks like staff to every other user. Because usernames
 * are stored lowercase, this set also covers `Admin`, `ADMIN` and `AdMiN` — the
 * variants are not separate identities.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // staff / authority
  "admin", "admins", "administrator", "root", "superuser", "sudo", "owner",
  "moderator", "mod", "staff", "team", "support", "helpdesk", "help",
  "security", "abuse", "billing", "payments", "legal", "privacy", "postmaster",
  "webmaster", "hostmaster", "noreply", "no-reply", "notifications",
  // product / brand
  "ollasuper", "olla", "ollagraph", "ollastack", "myos", "system", "official",
  // routes / infrastructure that could collide with a path or a service name
  "api", "app", "www", "mail", "ftp", "cdn", "static", "assets", "media",
  "login", "logout", "signin", "signup", "register", "auth", "oauth", "sso",
  "settings", "account", "profile", "me", "user", "users", "chat", "files",
  "projects", "scheduled", "share", "shared", "public", "internal", "dashboard",
  "console", "status", "health", "metrics", "docs", "blog", "about", "terms",
  // values that break naive comparisons
  "null", "undefined", "none", "nan", "true", "false", "anonymous", "guest",
  "deleted", "unknown", "test",
]);

export const USERNAME_TAKEN_MESSAGE = "That username is already taken.";
export const USERNAME_RESERVED_MESSAGE = "That username isn't available.";

/**
 * Validate + normalise a username, or throw a clean ConvexError.
 *
 * Returns the STORAGE form (trimmed, lowercased). Reserved names get the same
 * "isn't available" wording as a taken one on purpose — telling a caller that a
 * name is *reserved* rather than *taken* is a small oracle about the namespace
 * and buys them nothing.
 */
export function assertUsableUsername(raw: string): string {
  const parsed = usernameSchema.safeParse(raw);
  if (!parsed.success) {
    // Surface the first rule's own message, never the raw zod dump.
    const issue = parsed.error.issues[0];
    throw new ConvexError(issue?.message ?? "That username isn't valid.");
  }
  const value = parsed.data;
  if (RESERVED_USERNAMES.has(value)) {
    throw new ConvexError(USERNAME_RESERVED_MESSAGE);
  }
  return value;
}

/** Max length for the free-text display name. */
export const DISPLAY_NAME_MAX = 50;

/**
 * Normalise a display name.
 *
 * Unlike `username` this is free text — spaces and unicode are legitimate — so
 * there is no charset rule. What it does do is strip control characters
 * (including the bidi overrides that let a name render as something else) and
 * apply NFC so two visually identical names are one string. Empty after
 * normalising means "clear it", which is a valid intent, not an error.
 */
/** C0/C1 controls, zero-width joiners and bidi overrides - the characters that
 *  let a display name render as something other than what is stored. */
function isStrippedCodePoint(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

export function normalizeDisplayName(raw: string): string | undefined {
  const cleaned = raw
    .normalize("NFC")
    // Stripped by CODE POINT, not a regex class: biome rejects a literal
    // control range in a regex, and the intent (drop C0/C1 plus the bidi and
    // zero-width spoofing set) reads more clearly as an explicit test.
    .split("")
    .filter((ch) => !isStrippedCodePoint(ch.codePointAt(0) ?? 0))
    .join("")
    .trim()
    .slice(0, DISPLAY_NAME_MAX);
  return cleaned || undefined;
}
