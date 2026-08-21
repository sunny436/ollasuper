import { z } from "zod";

/**
 * Client-side mirrors of the server's auth rules.
 *
 * The sign-up password schema is deliberately kept in lockstep with
 * `validatePasswordRequirements` in packages/backend/convex/auth.ts. If the two
 * drift, the form accepts something the server then rejects, and the user only
 * finds out after a round trip.
 */
const email = z
  .string()
  .trim()
  .min(1, "Email is required")
  .email("Enter a valid email address");

/**
 * Sign-UP is restricted to these consumer providers. Client mirror of
 * ALLOWED_SIGNUP_DOMAINS in convex/authPolicy.ts — the server is the authority;
 * this only gives instant feedback. Login/forgot are NOT domain-restricted
 * (existing accounts keep working, and forgot must not reveal domains).
 */
const ALLOWED_SIGNUP_DOMAINS = new Set([
  "gmail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
  "icloud.com", "proton.me", "protonmail.com", "zoho.com", "aol.com",
  "gmx.com", "mail.com",
]);
const signUpEmail = email.refine(
  (e) => ALLOWED_SIGNUP_DOMAINS.has(e.toLowerCase().split("@")[1] ?? ""),
  "That email domain isn't supported. Use Gmail, Outlook, Yahoo, iCloud, Proton, Zoho, AOL, GMX or Mail.com.",
);

/**
 * Sign-IN takes any non-empty password ON PURPOSE. Applying the sign-up policy
 * here would lock out every account created before that policy existed — the
 * server is the only thing entitled to judge an existing password.
 */
const signInPassword = z.string().min(1, "Password is required");

const signUpPassword = z
  .string()
  .min(8, "At least 8 characters")
  .regex(/[a-z]/, "Add a lowercase letter")
  .regex(/[A-Z]/, "Add an uppercase letter")
  .regex(/\d/, "Add a number")
  .regex(/[^A-Za-z0-9]/, "Add a special character");

/**
 * Persisted to `users.name` via the `profile` function on the Password provider
 * in convex/auth.ts. Without that function the value is silently discarded.
 */
const name = z.string().trim().min(2, "Full name must be at least 2 characters");

/** 8-digit codes from ResendOTPVerify / ResendOTPReset. */
const code = z
  .string()
  .trim()
  .min(1, "Enter the code we emailed you");

export const signInSchema = z.object({ email, password: signInPassword });
// email: signUpEmail (domain-restricted). The password's "must not contain your
// name/email" rule is cross-field, so it is enforced server-side (in
// convex/auth.ts profile) rather than mirrored here — keeping this a plain
// z.object so the form's per-field `.shape.<field>` validators keep working.
export const signUpSchema = z.object({
  name,
  email: signUpEmail,
  password: signUpPassword,
});
export const verifySchema = z.object({ code });
export const forgotSchema = z.object({ email });
export const resetSchema = z.object({ code, newPassword: signUpPassword });
export const otpEmailSchema = z.object({ email });
export const otpCodeSchema = z.object({ code });

export type SignInValues = z.infer<typeof signInSchema>;
export type SignUpValues = z.infer<typeof signUpSchema>;
export type VerifyValues = z.infer<typeof verifySchema>;
export type ForgotValues = z.infer<typeof forgotSchema>;
export type ResetValues = z.infer<typeof resetSchema>;
export type OtpEmailValues = z.infer<typeof otpEmailSchema>;
export type OtpCodeValues = z.infer<typeof otpCodeSchema>;
