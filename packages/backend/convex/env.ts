import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    CONVEX_SITE_URL: z.string().url(),
    LOOPS_FORM_ID: z.optional(z.string().min(1)),
    POLAR_ORGANIZATION_TOKEN: z.string().min(1),
    POLAR_WEBHOOK_SECRET: z.string().min(1),
    RESEND_API_KEY: z.optional(z.string().min(1)),
    RESEND_SENDER_EMAIL_AUTH: z.optional(z.string().email()),
    SITE_URL: z.string().url(),
    AUTH_GOOGLE_ID: z.string().min(1),
    AUTH_GOOGLE_SECRET: z.string().min(1),
    // AI inference plane. OPTIONAL on purpose: the deployment runs with
    // VALIDATE_ENV=true, so marking these required would fail validation on the
    // live backend the moment this code lands but before the Python service is
    // configured. chat.stream.dispatch hard-fails at the call site instead,
    // matching how jobs.processJob handles a missing BACKEND_BASE_URL.
    AI_BASE_URL: z.optional(z.string().url()),
    AI_SERVICE_KEY: z.optional(z.string().min(1)),
    AI_INGRESS_SECRET: z.optional(z.string().min(1)),
    // Phase 4 — first-party Google connectors (GSC/GA4). OPTIONAL for the same
    // reason as the AI vars above (VALIDATE_ENV would fail the live backend before
    // the operator configures them); connectors.ts/crypto.ts hard-fail at the call
    // site. Separate from the AUTH_GOOGLE_* LOGIN client (different scopes/redirect).
    CONNECTOR_GOOGLE_ID: z.optional(z.string().min(1)),
    CONNECTOR_GOOGLE_SECRET: z.optional(z.string().min(1)),
    CONNECTOR_ENC_KEY: z.optional(z.string().min(1)),
    CONNECTOR_REDIRECT_URI: z.optional(z.string().url()),
  },
  runtimeEnv: {
    CONVEX_SITE_URL: process.env.CONVEX_SITE_URL,
    LOOPS_FORM_ID: process.env.LOOPS_FORM_ID,
    POLAR_ORGANIZATION_TOKEN: process.env.POLAR_ORGANIZATION_TOKEN,
    POLAR_WEBHOOK_SECRET: process.env.POLAR_WEBHOOK_SECRET,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_SENDER_EMAIL_AUTH: process.env.RESEND_SENDER_EMAIL_AUTH,
    SITE_URL: process.env.SITE_URL,
    AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID,
    AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_SERVICE_KEY: process.env.AI_SERVICE_KEY,
    AI_INGRESS_SECRET: process.env.AI_INGRESS_SECRET,
    CONNECTOR_GOOGLE_ID: process.env.CONNECTOR_GOOGLE_ID,
    CONNECTOR_GOOGLE_SECRET: process.env.CONNECTOR_GOOGLE_SECRET,
    CONNECTOR_ENC_KEY: process.env.CONNECTOR_ENC_KEY,
    CONNECTOR_REDIRECT_URI: process.env.CONNECTOR_REDIRECT_URI,
  },
  skipValidation: !process.env.VALIDATE_ENV,
});
