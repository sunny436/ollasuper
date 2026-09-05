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
 * There is deliberately NO allow-list of email providers.
 *
 * There used to be one — twelve consumer domains — which meant every work
 * address was refused at sign-up with "That email domain isn't supported."
 * A list of approved providers cannot be maintained against the real world, and
 * the escape hatch it needed (AUTH_EXTRA_ALLOWED_DOMAINS) had already been
 * switched on in production to get the e2e mailbox through, which is the usual
 * sign that a rule is fighting its own users.
 *
 * Removing it required care, because the list was doing security work nobody
 * had noticed: throwaway providers were rejected only because they were not on
 * it. `isDisposableEmail` above was written for that job and was never called
 * from this file — dead code kept alive by its tests. `assertUsableEmail` now
 * calls it explicitly, so the protection survives the list that replaced it.
 *
 * The real boundary was never the domain. It is mandatory email verification:
 * a sign-up issues no session until a code sent to that address comes back.
 */
export const INVALID_EMAIL_MESSAGE = "Enter a valid email address.";
export const DISPOSABLE_DOMAIN_MESSAGE =
  "That looks like a temporary email address. Please use an address you can receive mail at.";

/**
 * Validate a sign-up address and return its normalized form.
 *
 * Domain policy is NOT an account-existence oracle, so the two failure reasons
 * carry specific, actionable messages (malformed vs. throwaway provider). What
 * must stay generic is anything that reveals whether an *account* exists — that
 * lives on the login/existence path, not here.
 */
export function assertUsableEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (!isValidEmailShape(normalized)) {
    throw new ConvexError(INVALID_EMAIL_MESSAGE);
  }
  // The ONLY domain rule. Partial by design and it says so: a curated list
  // raises the cost of casual throwaway abuse and will never catch an attacker
  // with a custom domain. Verification is what actually holds.
  if (isDisposableEmail(normalized)) {
    throw new ConvexError(DISPOSABLE_DOMAIN_MESSAGE);
  }
  return normalized;
}

/**
 * Extremely-common / trivially-guessable passwords, curated in-repo (no network,
 * no runtime dep). Not exhaustive — it raises the floor against the passwords a
 * spraying attack tries first. Compared case-insensitively.
 */
// Built lowercased so membership tests (which lowercase their input) are
// case-insensitive regardless of how an entry is written below.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "passw0rd", "p@ssw0rd", "p@ssword",
  "123456", "1234567", "12345678", "123456789", "1234567890", "12345", "111111",
  "000000", "121212", "112233", "654321", "123123", "666666", "qwerty",
  "qwerty123", "qwertyuiop", "1q2w3e4r", "1qaz2wsx", "zaq12wsx", "asdfghjkl",
  "abc123", "a1b2c3", "iloveyou", "admin", "admin123", "root", "letmein",
  "welcome", "welcome1", "monkey", "dragon", "sunshine", "princess", "football",
  "baseball", "superman", "batman", "master", "hello", "hello123", "freedom",
  "whatever", "trustno1", "starwars", "michael", "shadow", "ashley", "test",
  "test123", "changeme", "secret", "login", "google", "facebook", "samsung",
  "photoshop", "ginger", "computer", "michelle", "jennifer", "jordan", "harley",
  "ranger", "hunter", "buster", "thomas", "robert", "matthew", "daniel",
  "andrew", "charlie", "summer", "winter", "spring", "autumn", "flower",
  "cheese", "cookie", "pepper", "chocolate", "soccer", "hockey", "killer",
  "george", "asdf", "asdfgh", "zxcvbnm", "qazwsx", "q1w2e3r4", "aaaaaa",
  "abcabc", "abcdef", "abcd1234", "passwordless", "password!", "P@ssw0rd!",
  "Password1", "Password1!", "Password123", "Password123!", "Qwerty123!",
  "Admin123!", "Welcome1!", "Welcome123", "Letmein1", "iloveyou1", "trustno1!",
].map((p) => p.toLowerCase()));

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase());
}

/**
 * Reject a password that embeds the user's own identity (name / email parts).
 * Throws a specific ConvexError; used by the sign-up `profile`, where name +
 * email are both available. Guards on length >= 3 so a one/two-char local part
 * or initial cannot flag every password.
 */
export function assertPasswordNotIdentity(
  password: string,
  email: string,
  name: string,
): void {
  const pw = password.toLowerCase();
  const contains = (part: string) =>
    part.length >= 3 && pw.includes(part.toLowerCase());

  if (name && contains(name.trim())) {
    throw new ConvexError("Password must not contain your name.");
  }
  const normalized = normalizeEmail(email);
  const local = normalized.split("@")[0] ?? "";
  const domainLabel = domainOf(normalized).split(".")[0] ?? "";
  if (contains(local) || contains(domainLabel)) {
    throw new ConvexError("Password must not contain part of your email.");
  }
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
