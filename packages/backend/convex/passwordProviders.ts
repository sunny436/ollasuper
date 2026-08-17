import { Email } from "@convex-dev/auth/providers/Email";
import { internal } from "./_generated/api";
import { deliverCode, generateNumericCode } from "./authCodes";

// Email providers for password-reset and email-verification codes.
//
// Codes are 8 digits, valid for 15 minutes, single-use, and stored sha256-hashed
// by the library in authVerificationCodes. Requesting a new code replaces the
// previous row for that account, so a resend invalidates its predecessor.
//
// Generation and delivery live in authCodes.ts so these two providers and the
// magic-OTP provider cannot drift on the security-relevant parts — in
// particular, codes are no longer logged when a mail transport is configured.

type Ctx = { runAction: (ref: unknown, args: unknown) => Promise<unknown> };

export const ResendOTPVerify = Email({
  id: "verify-otp",
  apiKey: process.env.RESEND_API_KEY,
  maxAge: 60 * 15,
  generateVerificationToken: async () => generateNumericCode(),
  sendVerificationRequest: async (
    { identifier, token }: { identifier: string; token: string },
    ctx?: Ctx,
  ): Promise<void> => {
    await deliverCode(ctx, "email verification", identifier, token, internal.email.sendEmail);
  },
});

export const ResendOTPReset = Email({
  id: "password-reset",
  apiKey: process.env.RESEND_API_KEY,
  maxAge: 60 * 15,
  generateVerificationToken: async () => generateNumericCode(),
  sendVerificationRequest: async (
    { identifier, token }: { identifier: string; token: string },
    ctx?: Ctx,
  ): Promise<void> => {
    await deliverCode(ctx, "password reset", identifier, token, internal.email.sendEmail);
  },
});
