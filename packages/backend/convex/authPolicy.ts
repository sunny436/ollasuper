import { ConvexError } from "convex/values";

/**
 * Email policy for sign-up. Deliberately dependency-free and side-effect-free so
 * it can be unit-tested directly and called from the Password provider's
 * `profile` function, which runs inside a mutation.
 */

/**
 * Canonical form used for comparison and storage in `users.emailNormalized`.
 *
 * NFKC first, because visually identical addresses can differ in code points
 * (full-width characters, compatibility forms) and would otherwise register as
 * two distinct accounts. Case-folding is applied to the whole address: the local
 * part is technically case-sensitive per RFC 5321, but no mainstream provider
 * treats it that way, and honouring it here would let `User@x.com` and
 * `user@x.com` become separate accounts for the same mailbox.
 *
 * Gmail dots and `+tag` suffixes are deliberately NOT stripped. That is a
 * provider-specific rule, applying it universally would merge genuinely
 * different addresses elsewhere, and it is exactly the kind of clever
 * normalisation that becomes an account-takeover vector.
 */
export function normalizeEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

/** Domain of a normalized address, or "" when the address is malformed. */
function domainOf(normalized: string): string {
  const at = normalized.lastIndexOf("@");
  return at === -1 ? "" : normalized.slice(at + 1);
}

/**
 * Curated list of high-volume throwaway providers.
 *
 * Kept small and in-repo on purpose: no network call on the signup hot path, no
 * runtime dependency that can fail closed, and every entry is reviewable in a
 * diff. Coverage is intentionally partial — this raises the cost of casual abuse
 * rather than claiming to be exhaustive, and it will never catch a determined
 * attacker with a custom domain.
 */
const DISPOSABLE_DOMAINS = new Set([
  "0-mail.com", "10minutemail.com", "20minutemail.com", "33mail.com",
  "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "sharklasers.com",
  "grr.la", "spam4.me", "mailinator.com", "mailinator.net", "mailinator2.com",
  "notmailinator.com", "reallymymail.com", "tempmail.com", "temp-mail.org",
  "temp-mail.io", "tempmailo.com", "tempmail.net", "tempr.email", "tmpmail.org",
  "throwawaymail.com", "trashmail.com", "trashmail.de", "trashmail.net",
  "wegwerfmail.de", "yopmail.com", "yopmail.net", "yopmail.fr", "cool.fr.nf",
  "jetable.org", "nospam.ze.tc", "nomail.xl.cx", "mega.zik.dj", "speed.1s.fr",
  "getnada.com", "nada.email", "inboxkitten.com", "emailondeck.com",
  "fakeinbox.com", "fakemailgenerator.com", "dispostable.com", "maildrop.cc",
  "mailnesia.com", "mailcatch.com", "mintemail.com", "mytrashmail.com",
  "spamgourmet.com", "spambog.com", "spamex.com", "mailexpire.com",
  "mohmal.com", "burnermail.io", "anonaddy.me", "moakt.com", "tempinbox.com",
  "byom.de", "discard.email", "discardmail.com", "spambox.us", "harakirimail.com",
  "incognitomail.org", "e4ward.com", "mail-temporaire.fr", "instant-mail.de",
  "linshiyouxiang.net", "1secmail.com", "1secmail.org", "1secmail.net",
  "vjuum.com", "laafd.com", "txcct.com", "esiix.com", "wwjmp.com", "dpptd.com",
  "kzccv.com", "qiott.com", "fexpost.com", "fexbox.org", "mailbox92.biz",
  "somoj.com", "armyspy.com", "cuvox.de", "dayrep.com", "einrot.com",
  "fleckens.hu", "gustr.com", "jourrapide.com", "rhyta.com", "superrito.com",
  "teleworm.us", "spam.la", "devnullmail.com", "objectmail.com", "proxymail.eu",
  "rcpt.at", "trash-mail.at", "trashmail.at", "wegwerfemail.de", "mailtemp.info",
  "tmail.ws", "tmails.net", "mailde.de", "mail-temp.com", "temporary-mail.net",
  "minuteinbox.com", "correotemporal.org", "emltmp.com", "mailpoof.com",
]);

/** True when the address belongs to a known throwaway provider. */
export function isDisposableEmail(email: string): boolean {
  return DISPOSABLE_DOMAINS.has(domainOf(normalizeEmail(email)));
}

/** Structural check. Intentionally conservative: no dot-atom edge cases, no IP literals. */
export function isValidEmailShape(email: string): boolean {
  const n = normalizeEmail(email);
  if (n.length === 0 || n.length > 254) return false;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(n)) return false;
  const [local] = n.split("@");
  return local !== undefined && local.length <= 64;
}

/**
 * Single message for every rejection reason.
 *
 * Distinguishing "invalid format" from "disposable provider" from "already
 * registered" would turn sign-up into an account/provider oracle, so all three
 * fail identically. See requirement 4: do not leak whether an account exists.
 */
export const GENERIC_EMAIL_REJECTION =
  "That email address can't be used. Please use a different one.";

/** Throws ConvexError with the generic message when the address is unusable. */
export function assertUsableEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!isValidEmailShape(normalized) || isDisposableEmail(normalized)) {
    throw new ConvexError(GENERIC_EMAIL_REJECTION);
  }
  return normalized;
}

/**
 * Google profile mapper. Exported so the control can be tested directly — a live
 * OAuth round trip needs credentials this deployment does not have.
 *
 * Two properties matter:
 *  - an UNVERIFIED Google email is refused. Google will issue a profile with
 *    email_verified:false, and accepting it lets an attacker register a Google
 *    account claiming a victim's address and land on the victim's user record.
 *  - identity is keyed on `sub`, the immutable subject, never the email. A user
 *    who changes their Gmail address keeps the same account, and a recycled
 *    address cannot inherit one.
 */
export function googleProfile(profile: Record<string, unknown>): {
  id: string;
  email: string;
  emailNormalized: string;
  name?: string;
  image?: string;
} {
  if (profile.email_verified !== true) {
    throw new ConvexError("Your Google account's email address is not verified.");
  }
  const email = normalizeEmail(String(profile.email ?? ""));
  return {
    id: String(profile.sub),
    email,
    emailNormalized: email,
    ...(typeof profile.name === "string" ? { name: profile.name } : {}),
    ...(typeof profile.picture === "string" ? { image: profile.picture } : {}),
  };
}
