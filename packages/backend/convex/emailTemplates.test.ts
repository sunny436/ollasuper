import { describe, expect, test } from "vitest";
import { buildAuthEmail, esc, expiryPhrase } from "./emailTemplates";

/**
 * The auth email template.
 *
 * Pure functions, so this needs no Convex and no network. The properties under
 * test are the ones that would either lie to a user about security-relevant
 * timing, hand someone else's markup into their inbox, or quietly break the
 * three e2e suites that locate auth mail by its subject.
 */

const CODE = "83920174"; // 8 digits, as generateNumericCode actually produces
const LABELS = ["OTP", "email verification", "password reset"] as const;
const NOW = 1_760_000_000_000;
const IN_15_MIN = new Date(NOW + 15 * 60_000);

describe("subject lines are unchanged", () => {
  /**
   * p2-auth.js and p-auth-edges.js find the code by matching the label in the
   * subject, and p-mail.js separates auth mail from scheduled-report mail the
   * same way. Rewording a subject silently breaks all three.
   */
  test.each(LABELS)("%s keeps `Your <label> code`", (label) => {
    const { subject } = buildAuthEmail({
      label,
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    expect(subject).toBe(`Your ${label} code`);
  });
});

describe("the expiry comes from the backend, not from a constant", () => {
  test("renders the real remaining minutes", () => {
    const { html, text } = buildAuthEmail({
      label: "email verification",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    expect(text).toContain("This code expires in 15 minutes.");
    expect(html).toContain("This code expires in 15 minutes.");
  });

  /**
   * The point of deriving from `expires`: change maxAge and the email follows,
   * with no second place to remember to edit.
   */
  test("a different expiry produces a different sentence", () => {
    expect(expiryPhrase(new Date(NOW + 5 * 60_000), NOW)).toBe(
      "This code expires in 5 minutes.",
    );
    expect(expiryPhrase(new Date(NOW + 60 * 60_000), NOW)).toBe(
      "This code expires in 60 minutes.",
    );
  });

  test("singular minute is not written as `1 minutes`", () => {
    expect(expiryPhrase(new Date(NOW + 60_000), NOW)).toBe(
      "This code expires in 1 minute.",
    );
  });

  /** A vague sentence beats a wrong number. */
  test.each([
    ["absent", undefined],
    ["null", null],
    ["unparseable", Number.NaN],
    ["already past", new Date(NOW - 60_000)],
  ])("%s expiry degrades to a sentence with no number", (_why, value) => {
    const phrase = expiryPhrase(value as Date | number | null | undefined, NOW);
    expect(phrase).toBe("This code expires shortly.");
    expect(phrase).not.toMatch(/\d/);
  });
});

describe("the code survives intact", () => {
  test("appears verbatim in both parts", () => {
    const { html, text } = buildAuthEmail({
      label: "OTP",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    expect(text).toContain(CODE);
    expect(html).toContain(CODE);
  });

  /**
   * The design shows visually separated digits. Doing that with literal spaces
   * makes the code copy as "8392 0174" and fail to paste — so the separation
   * must be letter-spacing, and the digits must stay contiguous in the markup.
   */
  test("no literal spacing is injected between digits", () => {
    const { html } = buildAuthEmail({
      label: "OTP",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    expect(html).not.toContain("8392 0174");
    expect(html).not.toContain("8&nbsp;3");
    expect(html).toContain("letter-spacing");
  });

  /**
   * The provider extracts OTPs at ingest and the e2e helper falls back to a
   * \b(\d{6,8})\b body scan. Neither the year nor the expiry may look like a code.
   */
  test("no other 6-8 digit run can be mistaken for the code", () => {
    const { text } = buildAuthEmail({
      label: "OTP",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    const runs = text.match(/\b\d{6,8}\b/g) ?? [];
    expect(runs).toEqual([CODE]);
  });
});

describe("the preheader never carries the code", () => {
  /**
   * The preheader is the client's preview line — and on a phone, the LOCK-SCREEN
   * preview. A one-time code must not be readable without unlocking the device.
   */
  test.each(LABELS)("%s keeps the code out of the preview", (label) => {
    const { html } = buildAuthEmail({
      label,
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    const preheader = /max-width:0;opacity:0;overflow:hidden;">([^<]*)</.exec(html);
    expect(preheader).not.toBeNull();
    expect(preheader?.[1]).toContain("expires");
    expect(preheader?.[1]).not.toContain(CODE);
  });
});

describe("the greeting is optional and never invented", () => {
  test("omitted entirely when no name is known", () => {
    const { html, text } = buildAuthEmail({
      label: "email verification",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    expect(text).not.toContain("Hello");
    expect(html).not.toContain("Hello");
  });

  test("used when a name is known", () => {
    const { html, text } = buildAuthEmail({
      label: "email verification",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
      name: "Sunny",
    });
    expect(text).toContain("Hello Sunny,");
    expect(html).toContain("Hello Sunny,");
  });

  test("a blank or whitespace name is treated as absent", () => {
    const { html } = buildAuthEmail({
      label: "OTP",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
      name: "   ",
    });
    expect(html).not.toContain("Hello");
  });

  /**
   * `users.name` is user-controlled and free-text, so it is the one untrusted
   * value in this template.
   */
  test("a hostile name cannot emit markup", () => {
    const { html } = buildAuthEmail({
      label: "OTP",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
      name: '<img src=x onerror="alert(1)">',
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="');
    expect(html).toContain("&lt;img");
  });

  test("esc covers every character that could break out", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("flow-specific copy", () => {
  test("each flow gets its own heading", () => {
    const headings = LABELS.map(
      (label) =>
        /<h1[^>]*>([^<]*)<\/h1>/.exec(
          buildAuthEmail({
            label,
            code: CODE,
            expires: IN_15_MIN,
            now: NOW,
          }).html,
        )?.[1],
    );
    expect(new Set(headings).size).toBe(3);
    expect(headings).toContain("Verify your email");
    expect(headings).toContain("Reset your password");
    expect(headings).toContain("Sign in to OllaSuper");
  });

  test("an unrecognised label still produces a usable email", () => {
    const { subject, html, text } = buildAuthEmail({
      label: "something new",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    expect(subject).toBe("Your something new code");
    expect(html).toContain(CODE);
    expect(text).toContain(CODE);
  });
});

describe("email-client constraints", () => {
  /** Gmail clips a message past ~102KB and hides everything after the cut. */
  test("stays far under Gmail's 102KB clipping threshold", () => {
    const { html } = buildAuthEmail({
      label: "email verification",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
      name: "Sunny",
    });
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(20_000);
  });

  test("carries no script, no remote asset and no tracking pixel", () => {
    const { html } = buildAuthEmail({
      label: "OTP",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/fonts\.googleapis/i);
  });

  /** Auto-inversion would put near-black text on a near-black ground. */
  test("declares a light colour scheme and paints its own backgrounds", () => {
    const { html } = buildAuthEmail({
      label: "OTP",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    expect(html).toContain('name="color-scheme" content="light"');
    expect(html).toContain('name="supported-color-schemes" content="light"');
    expect(html).toContain("bgcolor=");
  });

  test("uses presentation tables and declares a language", () => {
    const { html } = buildAuthEmail({
      label: "OTP",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('role="presentation"');
  });

  /**
   * The brand wordmark is a bg-clip-text gradient in the app, which email
   * clients strip — it has to be solid text or it renders as nothing.
   */
  test("renders the wordmark as solid brand-coloured text", () => {
    const { html } = buildAuthEmail({
      label: "OTP",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    expect(html).toContain("OLLASUPER");
    expect(html).toContain("#4F8BF0");
    expect(html).not.toContain("background-clip");
    expect(html).not.toContain("linear-gradient");
  });

  /** Transactional mail must not invite unsubscribing from security email. */
  test("adds no unsubscribe affordance", () => {
    const { html } = buildAuthEmail({
      label: "OTP",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    expect(html.toLowerCase()).not.toContain("unsubscribe");
  });

  /** No support address or URL exists in the product; inventing one is worse. */
  test("claims no support channel the product does not have", () => {
    const { html } = buildAuthEmail({
      label: "OTP",
      code: CODE,
      expires: IN_15_MIN,
      now: NOW,
    });
    expect(html.toLowerCase()).not.toContain("contact support");
    expect(html).not.toContain("mailto:");
  });
});
