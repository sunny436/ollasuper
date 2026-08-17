import Google from "@auth/core/providers/google";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { ResendOTP } from "./ResendOTP";
import { ResendOTPReset, ResendOTPVerify } from "./passwordProviders";

// Full auth: email+password (with strength policy, email verification, and password reset),
// magic email OTP, and Google OAuth (set AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET to activate).
const PasswordWithFlows = Password({
  verify: ResendOTPVerify,
  reset: ResendOTPReset,
  // Without this, Password falls back to its defaultProfile, which returns
  // `{ email }` and nothing else — so a `name` sent by the sign-up form would be
  // accepted and then silently dropped. `users.name` is already optional in the
  // schema, and the dashboard sidebar renders it, so persist it here.
  // The expected return is WithoutSystemFields<Doc<"users">> & { email: string },
  // and Convex's `Value` does not include `undefined`. So `name` is either a real
  // string or absent from the object entirely — never explicitly undefined, which
  // is what a ternary or `name: string | undefined` would produce.
  profile: (params) => {
    const doc: Record<string, string> & { email: string } = {
      email: params.email as string,
    };
    const name = typeof params.name === "string" ? params.name.trim() : "";
    if (name) doc.name = name;
    return doc;
  },
  validatePasswordRequirements: (password: string) => {
    if (
      password.length < 8 ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/\d/.test(password)
    ) {
      throw new ConvexError(
        "Password must be at least 8 characters and include upper, lower, and a number.",
      );
    }
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [PasswordWithFlows, ResendOTP, Google],
  // Brute-force protection: per-email token bucket (default is 10/hr) on password + OTP.
  signIn: { maxFailedAttempsPerHour: 5 },
});
