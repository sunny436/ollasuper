import { v } from "convex/values";
import { action } from "./_generated/server";
import { env } from "./env";

/**
 * The newsletter form on the marketing site.
 *
 * ANONYMOUS ON PURPOSE — apps/web is built and served (deploy/05-build-apps.sh,
 * 06-systemd.sh) and a newsletter signup that required an account would be
 * pointless. So the problem here was never missing authentication; it was that
 * an anonymous caller chose BOTH fields freely and got the provider's raw
 * answer back:
 *
 *   * `email` was any string, so this endpoint would sign arbitrary third-party
 *     addresses up to a list that sends in OllaSuper's name — mail abuse
 *     attributed to this domain's reputation.
 *   * `userGroup` was any string, so anyone could invent segments and pollute
 *     the provider's segmentation.
 *   * the provider's JSON was returned verbatim, which made this a free oracle
 *     for whatever Loops chooses to say (including whether an address is
 *     already subscribed).
 *
 * Rate limiting is deliberately NOT attempted here: `consumeWindow` is keyed on
 * a userId and there is none, and a per-IP limit is impossible in a Convex
 * action, which gets no request object. That is a real, still-open gap and it
 * belongs at the edge — see the Cloudflare item in SECURITY-AUDIT-WSTG.md §G.2.
 * Narrowing the input is what CAN be done here, so it is what is done here.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_CHARS = 254; // RFC 5321 practical maximum
/**
 * The only segments this product actually sends.
 *
 * `v1-newsletter` is the literal the one real caller passes
 * (apps/web/src/components/header.tsx:68) — it is FIRST because it is also the
 * fallback, so an unrecognised value degrades to the segment the site already
 * uses rather than inventing a new one.
 */
const DEFAULT_USER_GROUP = "v1-newsletter";
const USER_GROUPS = new Set([DEFAULT_USER_GROUP, "waitlist"]);

export const subscribe = action({
  args: {
    email: v.string(),
    userGroup: v.string(),
  },
  handler: async (_ctx, args): Promise<{ ok: boolean }> => {
    const email = args.email.trim().toLowerCase();
    if (email.length > MAX_EMAIL_CHARS || !EMAIL_RE.test(email)) {
      return { ok: false };
    }
    const userGroup = USER_GROUPS.has(args.userGroup)
      ? args.userGroup
      : DEFAULT_USER_GROUP;

    if (!env.LOOPS_FORM_ID) return { ok: false };

    try {
      const res = await fetch(
        `https://app.loops.so/api/newsletter-form/${env.LOOPS_FORM_ID}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, userGroup }),
        },
      );
      // Only whether it worked. The provider's body is not ours to hand to an
      // anonymous caller, and echoing it is what made this an oracle.
      return { ok: res.ok };
    } catch {
      return { ok: false };
    }
  },
});
