/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import { hasMailTransport } from "./authCodes";
import schema from "./schema";

/**
 * AUTH email over Ollastack.
 *
 * This path had no coverage at all, which is part of how production ended up
 * posting every verification code into a local Mailpit catcher while looking
 * healthy. The properties here are the ones that decide whether a real user can
 * get into their account:
 *
 *   - a send that did not happen must THROW, never return quietly
 *   - a 200 carrying `dry_run` is not a send
 *   - `smtp` is refused outright on a production deployment
 *   - the bearer token never reaches an error message, because
 *     authCodes.deliverCode logs `e.message`
 */

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);
const MAILBOX = "mb_auth";
const SEND_PATH = `/api/mailboxes/${MAILBOX}/send`;
const TOKEN = "fmd_supersecret_do_not_leak";

const realFetch = globalThis.fetch;

let sent: Array<{ url: string; body: Record<string, unknown> }> = [];
let nextStatus = 200;
let nextDeliveryStatus = "sent";
let nextErrorCode = "PROVIDER_ERROR";

beforeEach(() => {
  sent = [];
  nextStatus = 200;
  nextDeliveryStatus = "sent";
  nextErrorCode = "PROVIDER_ERROR";
  process.env.AUTH_EMAIL_TRANSPORT = "ollastack";
  process.env.OLLASTACK_MAIL_TOKEN = TOKEN;
  process.env.OLLASTACK_AUTH_MAILBOX_ID = MAILBOX;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes(SEND_PATH)) {
      sent.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      if (nextStatus !== 200) {
        return new Response(
          JSON.stringify({ error: { code: nextErrorCode } }),
          { status: nextStatus },
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          data: { id: "msg_auth_1", deliveryStatus: nextDeliveryStatus },
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of [
    "AUTH_EMAIL_TRANSPORT",
    "OLLASTACK_MAIL_TOKEN",
    "OLLASTACK_AUTH_MAILBOX_ID",
    "OLLASTACK_MAIL_BASE_URL",
    "SITE_URL",
    "SMTP_HOST",
    "ALLOW_SMTP_TRANSPORT",
  ]) {
    delete process.env[k];
  }
});

const send = (t: ReturnType<typeof convexTest>) =>
  t.action(internal.email.sendEmail, {
    to: "user@example.com",
    subject: "Your email verification code",
    text: "Your email verification code is 12345678",
  });

describe("auth email over ollastack", () => {
  test("sends from the AUTH mailbox, with the code intact", async () => {
    const t = convexTest(schema, modules);
    await send(t);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain(SEND_PATH);
    expect(sent[0].body.to).toBe("user@example.com");
    expect(sent[0].body.text).toContain("12345678");
    // Plain text only: a one-time code needs no markup, and text-only mail is
    // less likely to be filtered.
    expect(sent[0].body.html).toBeUndefined();
  });

  test("uses the auth mailbox, never the reports one", async () => {
    const t = convexTest(schema, modules);
    process.env.OLLASTACK_REPORTS_MAILBOX_ID = "mb_reports";
    await send(t);
    expect(sent[0].url).toContain(MAILBOX);
    expect(sent[0].url).not.toContain("mb_reports");
    // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
    delete process.env.OLLASTACK_REPORTS_MAILBOX_ID;
  });

  /**
   * The defect class this whole change exists to remove: the provider answers
   * 200 and reports it threw the message away.
   */
  test("a 200 with deliveryStatus dry_run THROWS, it is not a send", async () => {
    const t = convexTest(schema, modules);
    nextDeliveryStatus = "dry_run";
    await expect(send(t)).rejects.toThrow(/provider_dry_run/);
  });

  test("a 200 with deliveryStatus failed THROWS", async () => {
    const t = convexTest(schema, modules);
    nextDeliveryStatus = "failed";
    await expect(send(t)).rejects.toThrow(/provider_status_failed/);
  });

  test("a missing token THROWS rather than returning quietly", async () => {
    const t = convexTest(schema, modules);
    // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
    delete process.env.OLLASTACK_MAIL_TOKEN;
    await expect(send(t)).rejects.toThrow(/ollastack_not_configured/);
    expect(sent).toEqual([]);
  });

  test("a missing mailbox id THROWS too", async () => {
    const t = convexTest(schema, modules);
    // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
    delete process.env.OLLASTACK_AUTH_MAILBOX_ID;
    await expect(send(t)).rejects.toThrow(/ollastack_not_configured/);
    expect(sent).toEqual([]);
  });

  test("a provider rate limit surfaces its code", async () => {
    const t = convexTest(schema, modules);
    nextStatus = 429;
    nextErrorCode = "RATE_LIMIT_EXCEEDED";
    await expect(send(t)).rejects.toThrow(/RATE_LIMIT_EXCEEDED/);
  });

  /**
   * authCodes.deliverCode logs `e.message` on failure. If the token were in
   * there, every failed send would print a live credential into the Convex log
   * stream — the same class of leak as the OTP logging that was removed.
   */
  test("the bearer token never appears in the thrown error", async () => {
    const t = convexTest(schema, modules);
    nextStatus = 401;
    nextErrorCode = "AUTHENTICATION_ERROR";
    await expect(send(t)).rejects.toThrow();
    const err = await send(t).catch((e: unknown) => e as Error);
    expect(String(err)).not.toContain(TOKEN);
    expect(String(err)).not.toContain("fmd_");
  });
});

describe("the smtp transport is refused on production", () => {
  test("smtp + a production SITE_URL throws instead of reaching Mailpit", async () => {
    const t = convexTest(schema, modules);
    process.env.AUTH_EMAIL_TRANSPORT = "smtp";
    process.env.SITE_URL = "https://app.ollasuper.com";
    process.env.SMTP_HOST = "172.18.0.1"; // the real Mailpit address
    await expect(send(t)).rejects.toThrow(/smtp transport refused/);
  });

  test("smtp is still fine on a loopback deployment", async () => {
    const t = convexTest(schema, modules);
    process.env.AUTH_EMAIL_TRANSPORT = "smtp";
    process.env.SITE_URL = "http://localhost:3000";
    // No SMTP_HOST, so it returns without sending — the point is that it does
    // NOT throw the production refusal.
    await expect(send(t)).resolves.toBeNull();
  });

  test("the explicit replica escape hatch is honoured", async () => {
    const t = convexTest(schema, modules);
    process.env.AUTH_EMAIL_TRANSPORT = "smtp";
    process.env.SITE_URL = "https://app.ollasuper.com";
    process.env.ALLOW_SMTP_TRANSPORT = "1";
    await expect(send(t)).resolves.toBeNull();
  });

  test("an unknown transport name fails closed, sending nothing", async () => {
    const t = convexTest(schema, modules);
    process.env.AUTH_EMAIL_TRANSPORT = "resend";
    await expect(send(t)).resolves.toBeNull();
    expect(sent).toEqual([]);
  });

  test("disabled sends nothing and does not throw", async () => {
    const t = convexTest(schema, modules);
    process.env.AUTH_EMAIL_TRANSPORT = "disabled";
    await expect(send(t)).resolves.toBeNull();
    expect(sent).toEqual([]);
  });
});

describe("the dev log-fallback stays off when Ollastack is configured", () => {
  test("an Ollastack token counts as a real mail transport", () => {
    // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
    delete process.env.SMTP_HOST;
    expect(hasMailTransport()).toBe(true);
  });

  test("with no transport at all the fallback is allowed again", () => {
    // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
    delete process.env.OLLASTACK_MAIL_TOKEN;
    // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
    delete process.env.SMTP_HOST;
    // biome-ignore lint/performance/noDelete: the only way to actually unset an env var
    delete process.env.RESEND_API_KEY;
    expect(hasMailTransport()).toBe(false);
  });
});
