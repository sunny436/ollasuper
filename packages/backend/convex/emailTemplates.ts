/**
 * The one place an OllaSuper auth email is composed.
 *
 * PLAIN MODULE ON PURPOSE. `authCodes.ts` is plain and imports this, and a plain
 * Convex module may not import from a `"use node"` one — the same constraint
 * that already forced `ollastack.ts` and `mailSubject.ts` to exist. So `esc`
 * lives HERE and `email.ts` (which is `"use node"`, for nodemailer) imports it
 * back; node → plain is legal, the reverse is not. One escape implementation.
 *
 * EMAIL, NOT A WEB PAGE. Tables with explicit `bgcolor`, inline styles, no
 * JavaScript, no remote images, no webfont link, no tracking pixel, and no
 * `List-Unsubscribe` (this is transactional mail, not marketing). Anything a
 * client strips must leave the message still readable.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape-first: nothing interpolated into the HTML can emit a tag. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * Brand, as the product actually defines it — not as the design reference does.
 *
 * The real wordmark (auth-panel.tsx) is a gradient clipped to text with
 * `background-clip: text`. Email clients strip that, which would render the
 * brand name invisible, so it is drawn as SOLID text in `#4F8BF0` — a real
 * mid-stop of that gradient. `logo.png` is deliberately unused: it is 1.6 MB,
 * and Outlook and much of Gmail block remote images by default, so the header
 * would simply be missing for those readers.
 */
const BRAND = "#4F8BF0";
/** Plus Jakarta Sans is self-hosted for the app and will not load in mail. */
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace";

const PAGE_BG = "#F4F6FB";
const CARD_BG = "#FFFFFF";
const BORDER = "#E6E8EF";
const TEXT = "#12141A";
const TEXT_SOFT = "#565C6B";
const TEXT_MUTED = "#8A90A0";
const CODE_BG = "#F7F9FC";

/**
 * Flow-specific copy. The three labels are exactly the ones `deliverCode`
 * already passes, and the SUBJECT is deliberately left as it is today
 * (`Your <label> code`): three e2e suites locate auth mail by that wording, and
 * p-mail.js separates auth mail from report mail with it. The redesign is the
 * body, not the subject.
 */
const COPY: Record<string, { heading: string; intro: string }> = {
  OTP: {
    heading: "Sign in to OllaSuper",
    intro:
      "Use the code below to sign in to your OllaSuper AI Workspace. It can only be used once.",
  },
  "email verification": {
    heading: "Verify your email",
    intro:
      "Use the code below to finish setting up your OllaSuper AI Workspace. It can only be used once.",
  },
  "password reset": {
    heading: "Reset your password",
    intro:
      "Use the code below to choose a new password for your OllaSuper AI Workspace. It can only be used once.",
  },
};

const FALLBACK = {
  heading: "Your verification code",
  intro:
    "Use the code below to continue. It can only be used once.",
};

/**
 * How long the code is valid, IN THE BACKEND'S OWN WORDS.
 *
 * `expires` is handed to every provider by @convex-dev/auth — it is the value
 * the library computed from `maxAge` and the value it enforces. Rendering it
 * means the email cannot drift from the real expiry, which a hardcoded "15
 * minutes" duplicated beside three `maxAge: 60 * 15` literals eventually would.
 *
 * Anything unusable (absent, unparseable, already past) degrades to a sentence
 * with no number in it. A wrong duration is worse than a vague one.
 */
export function expiryPhrase(
  expires: Date | number | null | undefined,
  now: number = Date.now(),
): string {
  const ms =
    expires instanceof Date
      ? expires.getTime()
      : typeof expires === "number"
        ? expires
        : Number.NaN;
  if (!Number.isFinite(ms)) return "This code expires shortly.";
  const minutes = Math.round((ms - now) / 60_000);
  if (minutes < 1) return "This code expires shortly.";
  return `This code expires in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

export type AuthEmail = { subject: string; text: string; html: string };

/**
 * Build one auth email.
 *
 * `name` is optional and stays optional: `deliverCode` only knows an email
 * address, and a magic-OTP sign-in can precede any user row. When it is absent
 * the greeting line is omitted entirely rather than guessed at from the address.
 */
export function buildAuthEmail(input: {
  label: string;
  code: string;
  expires?: Date | number | null;
  name?: string | null;
  now?: number;
}): AuthEmail {
  const { label, code } = input;
  const copy = COPY[label] ?? FALLBACK;
  const expiry = expiryPhrase(input.expires, input.now ?? Date.now());
  const name = (input.name ?? "").trim();
  const greeting = name ? `Hello ${name},` : "";
  // Derived from `expires` rather than a fresh clock so the output is a pure
  // function of its inputs and the unit tests are deterministic.
  const year = new Date(
    input.expires instanceof Date
      ? input.expires.getTime()
      : typeof input.expires === "number"
        ? input.expires
        : (input.now ?? Date.now()),
  ).getUTCFullYear();

  // Unchanged on purpose — see COPY.
  const subject = `Your ${label} code`;

  // The plain-text part is NOT a fallback afterthought. It is what keeps this
  // deliverable if the HTML is stripped or filtered, and it is the shape the
  // provider's own OTP extractor already recognises.
  const text = [
    greeting,
    copy.intro,
    "",
    `Your ${label} code is ${code}`,
    "",
    expiry,
    "If you did not request this, you can safely ignore this email.",
  ]
    .filter((line, i) => !(i === 0 && line === ""))
    .join("\n");

  const html = renderHtml({
    heading: copy.heading,
    intro: copy.intro,
    greeting,
    code,
    expiry,
    year,
  });

  return { subject, text, html };
}

function renderHtml(v: {
  heading: string;
  intro: string;
  greeting: string;
  code: string;
  expiry: string;
  year: number;
}): string {
  const td = `font-family:${FONT};`;
  // PREHEADER: the client's preview line, and on a phone the LOCK-SCREEN
  // preview. It deliberately carries the expiry and never the code — a
  // one-time code should not be readable without unlocking the device.
  const preheader = esc(v.expiry);

  const greetingBlock = v.greeting
    ? `<p style="${td}margin:0 0 12px;font-size:16px;line-height:24px;color:${TEXT_SOFT};">${esc(v.greeting)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<!-- Light only. Without this, Apple Mail and Outlook auto-invert the card and
     the near-black text lands on a near-black ground. -->
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(v.heading)}</title>
<style>
  /* Progressive only: every rule below has an inline equivalent, because
     Gmail's clipped view and Outlook drop or mangle <style>. */
  @media only screen and (max-width:600px){
    .p-outer{padding:16px 12px !important}
    .p-inner{padding:28px 20px !important}
    /* 8 digits, not the 6 a mock might assume — this has to fit 320px. */
    .code{font-size:28px !important;letter-spacing:6px !important}
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${PAGE_BG};">
<div style="display:none;font-size:1px;color:${PAGE_BG};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${PAGE_BG}" style="background-color:${PAGE_BG};">
<tr><td align="center" class="p-outer" style="padding:40px 20px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background-color:${CARD_BG};border:1px solid ${BORDER};border-radius:14px;">

<tr><td style="${td}padding:26px 32px;border-bottom:1px solid ${BORDER};">
<span style="${td}font-size:19px;font-weight:800;font-style:italic;letter-spacing:0.02em;color:${BRAND};text-transform:uppercase;">OLLASUPER</span>
</td></tr>

<tr><td class="p-inner" style="padding:34px 32px 30px;">
<h1 style="${td}margin:0 0 18px;font-size:23px;line-height:30px;font-weight:700;color:${TEXT};">${esc(v.heading)}</h1>
${greetingBlock}
<p style="${td}margin:0 0 26px;font-size:16px;line-height:24px;color:${TEXT_SOFT};">${esc(v.intro)}</p>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
<tr><td align="center" bgcolor="${CODE_BG}" style="background-color:${CODE_BG};border:1px solid ${BORDER};border-radius:10px;padding:22px 12px;">
<!-- letter-spacing ONLY. Literal spaces between digits would make the code
     copy as "1234 5678" and fail to paste into the input. -->
<span class="code" style="font-family:${MONO};font-size:34px;line-height:42px;font-weight:700;letter-spacing:8px;color:${TEXT};">${esc(v.code)}</span>
</td></tr>
</table>

<p style="${td}margin:26px 0 0;font-size:14px;line-height:21px;color:${TEXT_SOFT};">${esc(v.expiry)}</p>
<p style="${td}margin:8px 0 0;font-size:14px;line-height:21px;color:${TEXT_MUTED};">If you did not request this, you can safely ignore this email. Your account stays unchanged.</p>
</td></tr>

<tr><td align="center" style="${td}padding:20px 32px;border-top:1px solid ${BORDER};">
<p style="${td}margin:0;font-size:12px;line-height:18px;color:${TEXT_MUTED};">&copy; ${v.year} OllaSuper. All rights reserved.</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}
