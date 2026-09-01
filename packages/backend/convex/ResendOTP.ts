import { Email } from "@convex-dev/auth/providers/Email";
import { internal } from "./_generated/api";
import { deliverCode, generateNumericCode } from "./authCodes";

/**
 * Magic email OTP provider (passwordless).
 *
 * Shares generation and delivery with the verification/reset providers via
 * authCodes.ts — same 8-digit rejection-sampled code, same 15-minute single-use
 * window, and the same rule that a code is only ever logged when the deployment
 * has no mail transport at all.
 */
export const ResendOTP = Email({
  id: "resend-otp",
  apiKey: process.env.RESEND_API_KEY,
  maxAge: 60 * 15,
  generateVerificationToken: async () => generateNumericCode(),
  async sendVerificationRequest(
    {
      identifier: email,
      token,
      expires,
    }: { identifier: string; token: string; expires?: Date },
    ctx?: { runAction: (ref: unknown, args: unknown) => Promise<unknown> },
  ): Promise<void> {
    await deliverCode(
      ctx,
      "OTP",
      email,
      token,
      internal.email.sendEmail,
      expires,
    );
  },
});
