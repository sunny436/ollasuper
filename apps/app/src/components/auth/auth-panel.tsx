"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useForm } from "@tanstack/react-form";
import { zodValidator } from "@tanstack/zod-form-adapter";
import { AnimatePresence, motion } from "framer-motion";
import { KeyRound, Loader2, Lock, Mail, ShieldCheck, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { toast } from "sonner";
import { IntelligenceCoreFallback } from "./intelligence-core-fallback";
import { OAuthRow } from "./oauth-row";
import {
  forgotSchema,
  otpCodeSchema,
  otpEmailSchema,
  resetSchema,
  signInSchema,
  signUpSchema,
  verifySchema,
} from "./schemas";

// three.js is ~150kB gzipped and this is the app's entry page, so it is loaded
// only after hydration and never lands in the login route's first-load bundle.
// ssr:false is legal here and only here — this file is a client component.
const IntelligenceCore = dynamic(
  () => import("./intelligence-core").then((m) => m.IntelligenceCore),
  { ssr: false, loading: () => <IntelligenceCoreFallback /> },
);

// Rendered during SSR too, so it cannot be new Date().getFullYear() without
// risking a hydration mismatch across a year boundary.
const COPYRIGHT_YEAR = 2026;

type Mode = "signIn" | "signUp" | "verify" | "forgot" | "reset" | "otp";

const FIELD_ROW =
  "relative flex items-center gap-3 border-[#E5E5EA] border-b-2 py-2 transition-colors focus-within:border-[#007AFF]";
const FIELD_INPUT =
  "w-full bg-transparent font-medium text-[#1D1D1F] text-sm placeholder-[#A1A1A6] focus:outline-none";
const SUBMIT =
  "flex min-w-[130px] items-center justify-center rounded-full bg-gradient-to-r from-[#007AFF] to-[#5856D6] px-8 py-2.5 font-bold text-white text-xs uppercase tracking-wider shadow-[#007AFF]/30 shadow-md transition-all hover:shadow-[#007AFF]/40 hover:shadow-lg disabled:opacity-60";
const LINK = "font-semibold text-[#86868B] text-xs transition-colors hover:text-[#007AFF]";

// ---------------------------------------------------------------------------
// Every sub-component below lives at MODULE SCOPE. Defining one inside the panel
// gives it a fresh identity on each render, so React unmounts and remounts the
// inputs on every keystroke — the field loses focus after one character. This is
// the same bug documented in the old auth-form.tsx and in chat's composer.tsx.
// ---------------------------------------------------------------------------

function FieldError({ errors }: { errors: unknown[] }) {
  const first = errors.find((e): e is string => typeof e === "string" && e.length > 0);
  if (!first) return null;
  return <span className="mt-1 inline-block font-medium text-[11px] text-red-500">{first}</span>;
}

function SubmitButton({ pending, label }: { pending: boolean; label: string }) {
  return (
    <button type="submit" disabled={pending} className={SUBMIT}>
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : label}
    </button>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center justify-between rounded-xl px-4 py-3 text-left font-bold text-sm uppercase tracking-wider transition-colors duration-300 ${
          active ? "text-[#1D1D1F]" : "text-white/80 hover:text-white"
        }`}
      >
        <span className="relative z-10">{label}</span>
      </button>
      {active && (
        <motion.div
          layoutId="activeTabNotch"
          className="absolute inset-0 rounded-xl bg-white shadow-lg md:-right-8 md:rounded-r-none md:rounded-l-2xl"
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
        />
      )}
    </div>
  );
}

function PanelFrame({
  formKey,
  onSubmit,
  children,
}: {
  formKey: string;
  onSubmit: (e: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <motion.form
      key={formKey}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.25 }}
      onSubmit={onSubmit}
      className="space-y-5"
    >
      {children}
    </motion.form>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[#86868B] text-xs">{children}</p>;
}

export function AuthPanel() {
  const { signIn } = useAuthActions();
  const [mode, setMode] = useState<Mode>("signIn");
  const [pending, setPending] = useState(false);
  // Carried across steps: the verify and reset panels need the address the code
  // was sent to, and the user should not have to retype it.
  const [email, setEmail] = useState("");

  /**
   * Lifted verbatim from the previous auth-form.tsx. ConvexError puts the
   * server's message on `.data` — that is how the password-policy text reaches
   * the user — with `.message` as the fallback for transport-level failures.
   */
  const go = (fn: () => Promise<void>) => async () => {
    setPending(true);
    try {
      await fn();
    } catch (err) {
      const data = (err as { data?: unknown })?.data;
      toast.error(
        typeof data === "string" ? data : (err as Error)?.message || "Something went wrong.",
      );
    } finally {
      setPending(false);
    }
  };

  const switchTo = (next: Mode) => setMode(next);

  const signInForm = useForm({
    validatorAdapter: zodValidator(),
    defaultValues: { email: "", password: "" },
    onSubmit: ({ value }) =>
      go(async () => {
        await signIn("password", { ...value, flow: "signIn" });
      })(),
  });

  const signUpForm = useForm({
    validatorAdapter: zodValidator(),
    defaultValues: { email: "", password: "" },
    onSubmit: ({ value }) =>
      go(async () => {
        await signIn("password", { ...value, flow: "signUp" });
        setEmail(value.email);
        toast.success("Account created. Enter the code we emailed you.");
        setMode("verify");
      })(),
  });

  const verifyForm = useForm({
    validatorAdapter: zodValidator(),
    defaultValues: { code: "" },
    onSubmit: ({ value }) =>
      go(async () => {
        await signIn("password", { email, code: value.code, flow: "email-verification" });
      })(),
  });

  const forgotForm = useForm({
    validatorAdapter: zodValidator(),
    defaultValues: { email: "" },
    onSubmit: ({ value }) =>
      go(async () => {
        await signIn("password", { email: value.email, flow: "reset" });
        setEmail(value.email);
        toast.success("Reset code sent.");
        setMode("reset");
      })(),
  });

  const resetForm = useForm({
    validatorAdapter: zodValidator(),
    defaultValues: { code: "", newPassword: "" },
    onSubmit: ({ value }) =>
      go(async () => {
        await signIn("password", {
          email,
          code: value.code,
          newPassword: value.newPassword,
          flow: "reset-verification",
        });
      })(),
  });

  const otpEmailForm = useForm({
    validatorAdapter: zodValidator(),
    defaultValues: { email: "" },
    onSubmit: ({ value }) =>
      go(async () => {
        await signIn("resend-otp", { email: value.email });
        setEmail(value.email);
        toast.success("One-time code sent.");
      })(),
  });

  const otpCodeForm = useForm({
    validatorAdapter: zodValidator(),
    defaultValues: { code: "" },
    onSubmit: ({ value }) =>
      go(async () => {
        await signIn("resend-otp", { email, code: value.code });
      })(),
  });

  const submit = (form: { handleSubmit: () => void }) => (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    form.handleSubmit();
  };

  const heading =
    mode === "signUp"
      ? "Create account"
      : mode === "verify"
        ? "Verify email"
        : mode === "forgot"
          ? "Reset password"
          : mode === "reset"
            ? "New password"
            : mode === "otp"
              ? "Email code"
              : "Login";

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-gradient-to-br from-[#1C1C1E] via-[#2C2C2E] to-[#0A0A0C] p-4 font-sans selection:bg-[#007AFF]/30 selection:text-white md:p-8">
      <div className="pointer-events-none absolute top-1/4 left-1/4 h-[500px] w-[500px] rounded-full bg-[#007AFF]/15 blur-[140px]" />
      <div className="pointer-events-none absolute right-1/4 bottom-1/4 h-[450px] w-[450px] rounded-full bg-[#AF52DE]/15 blur-[140px]" />

      <div className="relative flex min-h-[590px] w-full max-w-[920px] flex-col overflow-hidden rounded-[32px] border border-white/20 bg-white shadow-[0_25px_70px_rgba(0,0,0,0.5)] md:flex-row">
        {/* Left ribbon panel */}
        <div className="relative flex w-full select-none flex-col justify-between overflow-hidden bg-gradient-to-br from-[#0051A8] via-[#007AFF] to-[#5856D6] p-8 md:w-[320px] md:p-10">
          <div className="pointer-events-none absolute -inset-[50%] opacity-25 mix-blend-overlay">
            <div className="absolute -left-[20%] top-[10%] h-[120px] w-[200%] rotate-[-35deg] bg-white shadow-2xl" />
            <div className="absolute -left-[20%] top-[40%] h-[160px] w-[200%] rotate-[-35deg] bg-cyan-300 shadow-2xl" />
            <div className="absolute -left-[20%] top-[70%] h-[100px] w-[200%] rotate-[-35deg] bg-purple-400 shadow-2xl" />
          </div>

          <div className="relative z-10">
            <div className="flex items-center gap-2">
              <span className="font-black text-2xl text-white tracking-wider">OLLASUPER</span>
              <span className="flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 font-bold text-[10px] text-white uppercase tracking-widest backdrop-blur-sm">
                <Sparkles className="h-2.5 w-2.5" />
                AI
              </span>
            </div>
            <p className="mt-1 font-medium text-white/70 text-xs">Super Intelligence Engine</p>
          </div>

          <div className="relative z-20 my-10 flex items-start gap-4 md:my-0 md:flex-col md:gap-6">
            <TabButton
              label="Login"
              active={mode === "signIn"}
              onClick={() => switchTo("signIn")}
            />
            <TabButton
              label="Sign up"
              active={mode === "signUp"}
              onClick={() => switchTo("signUp")}
            />
          </div>

          <div className="relative z-10 flex items-center justify-between text-[11px] text-white/60">
            <span>&copy; {COPYRIGHT_YEAR} Ollasuper Workspaces</span>
            <span className="flex items-center gap-1 text-[10px]">
              <ShieldCheck className="h-3 w-3" /> Convex Auth
            </span>
          </div>
        </div>

        {/* Right form panel */}
        <div className="relative z-10 flex flex-1 flex-col justify-between bg-white p-8 md:p-12">
          <div className="mt-2 mb-6 flex flex-col items-center text-center">
            <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-tr from-[#007AFF] via-[#5AC8FA] to-[#AF52DE] p-[3px] shadow-[0_10px_25px_rgba(0,122,255,0.35)]">
              <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-[#1C1C1E]">
                <IntelligenceCore />
              </div>
            </div>
            <h1 className="mt-4 font-black text-2xl text-[#1D1D1F] uppercase tracking-widest">
              {heading}
            </h1>
          </div>

          <div className="mx-auto w-full max-w-md">
            {/* mode="wait" is load-bearing, not decorative: e2e/p2-auth.js fills
                input[type="email"] without .first(), so two mounted forms would
                be a Playwright strict-mode violation. */}
            <AnimatePresence mode="wait">
              {mode === "signIn" && (
                <PanelFrame formKey="signIn" onSubmit={submit(signInForm)}>
                  <signInForm.Field name="email" validators={{ onSubmit: signInSchema.shape.email }}>
                    {(field) => (
                      <div>
                        <div className={FIELD_ROW}>
                          <Mail className="h-5 w-5 text-[#86868B]" />
                          <input
                            id="email"
                            name="email"
                            type="email"
                            autoComplete="email"
                            placeholder="Email Address"
                            aria-label="Email Address"
                            className={FIELD_INPUT}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                          />
                        </div>
                        <FieldError errors={field.state.meta.errors} />
                      </div>
                    )}
                  </signInForm.Field>

                  <signInForm.Field
                    name="password"
                    validators={{ onSubmit: signInSchema.shape.password }}
                  >
                    {(field) => (
                      <div>
                        <div className={FIELD_ROW}>
                          <Lock className="h-5 w-5 text-[#86868B]" />
                          <input
                            id="password"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            placeholder="Password"
                            aria-label="Password"
                            className={FIELD_INPUT}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                          />
                        </div>
                        <FieldError errors={field.state.meta.errors} />
                      </div>
                    )}
                  </signInForm.Field>

                  <div className="flex items-center justify-between pt-2">
                    <button type="button" className={LINK} onClick={() => switchTo("forgot")}>
                      Forgot password?
                    </button>
                    <SubmitButton pending={pending} label="Login" />
                  </div>
                  <button type="button" className={`${LINK} block`} onClick={() => switchTo("otp")}>
                    Sign in with a one-time email code
                  </button>
                </PanelFrame>
              )}

              {mode === "signUp" && (
                <PanelFrame formKey="signUp" onSubmit={submit(signUpForm)}>
                  <signUpForm.Field name="email" validators={{ onSubmit: signUpSchema.shape.email }}>
                    {(field) => (
                      <div>
                        <div className={FIELD_ROW}>
                          <Mail className="h-5 w-5 text-[#86868B]" />
                          <input
                            id="signup-email"
                            name="email"
                            type="email"
                            autoComplete="email"
                            placeholder="Email Address"
                            aria-label="Email Address"
                            className={FIELD_INPUT}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                          />
                        </div>
                        <FieldError errors={field.state.meta.errors} />
                      </div>
                    )}
                  </signUpForm.Field>

                  <signUpForm.Field
                    name="password"
                    validators={{ onSubmit: signUpSchema.shape.password }}
                  >
                    {(field) => (
                      <div>
                        <div className={FIELD_ROW}>
                          <Lock className="h-5 w-5 text-[#86868B]" />
                          <input
                            id="signup-password"
                            name="password"
                            type="password"
                            autoComplete="new-password"
                            placeholder="Password"
                            aria-label="Password"
                            className={FIELD_INPUT}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                          />
                        </div>
                        <FieldError errors={field.state.meta.errors} />
                      </div>
                    )}
                  </signUpForm.Field>

                  <Hint>At least 8 characters, with upper, lower and a number.</Hint>
                  <div className="flex items-center justify-end pt-2">
                    <SubmitButton pending={pending} label="Sign up" />
                  </div>
                </PanelFrame>
              )}

              {mode === "verify" && (
                <PanelFrame formKey="verify" onSubmit={submit(verifyForm)}>
                  <Hint>
                    Enter the code sent to <span className="font-medium">{email}</span>.
                  </Hint>
                  <verifyForm.Field name="code" validators={{ onSubmit: verifySchema.shape.code }}>
                    {(field) => (
                      <div>
                        <div className={FIELD_ROW}>
                          <KeyRound className="h-5 w-5 text-[#86868B]" />
                          <input
                            id="verify-code"
                            name="code"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            placeholder="Verification code"
                            aria-label="Verification code"
                            className={FIELD_INPUT}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                          />
                        </div>
                        <FieldError errors={field.state.meta.errors} />
                      </div>
                    )}
                  </verifyForm.Field>
                  <div className="flex items-center justify-between pt-2">
                    <button type="button" className={LINK} onClick={() => switchTo("signIn")}>
                      Back to login
                    </button>
                    <SubmitButton pending={pending} label="Verify" />
                  </div>
                </PanelFrame>
              )}

              {mode === "forgot" && (
                <PanelFrame formKey="forgot" onSubmit={submit(forgotForm)}>
                  <Hint>We will email you a code to set a new password.</Hint>
                  <forgotForm.Field name="email" validators={{ onSubmit: forgotSchema.shape.email }}>
                    {(field) => (
                      <div>
                        <div className={FIELD_ROW}>
                          <Mail className="h-5 w-5 text-[#86868B]" />
                          <input
                            id="forgot-email"
                            name="email"
                            type="email"
                            autoComplete="email"
                            placeholder="Email Address"
                            aria-label="Email Address"
                            className={FIELD_INPUT}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                          />
                        </div>
                        <FieldError errors={field.state.meta.errors} />
                      </div>
                    )}
                  </forgotForm.Field>
                  <div className="flex items-center justify-between pt-2">
                    <button type="button" className={LINK} onClick={() => switchTo("signIn")}>
                      Back to login
                    </button>
                    <SubmitButton pending={pending} label="Send code" />
                  </div>
                </PanelFrame>
              )}

              {mode === "reset" && (
                <PanelFrame formKey="reset" onSubmit={submit(resetForm)}>
                  <Hint>
                    Enter the reset code sent to <span className="font-medium">{email}</span>.
                  </Hint>
                  <resetForm.Field name="code" validators={{ onSubmit: resetSchema.shape.code }}>
                    {(field) => (
                      <div>
                        <div className={FIELD_ROW}>
                          <KeyRound className="h-5 w-5 text-[#86868B]" />
                          <input
                            id="reset-code"
                            name="code"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            placeholder="Reset code"
                            aria-label="Reset code"
                            className={FIELD_INPUT}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                          />
                        </div>
                        <FieldError errors={field.state.meta.errors} />
                      </div>
                    )}
                  </resetForm.Field>
                  <resetForm.Field
                    name="newPassword"
                    validators={{ onSubmit: resetSchema.shape.newPassword }}
                  >
                    {(field) => (
                      <div>
                        <div className={FIELD_ROW}>
                          <Lock className="h-5 w-5 text-[#86868B]" />
                          <input
                            id="reset-password"
                            name="newPassword"
                            type="password"
                            autoComplete="new-password"
                            placeholder="New password"
                            aria-label="New password"
                            className={FIELD_INPUT}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                          />
                        </div>
                        <FieldError errors={field.state.meta.errors} />
                      </div>
                    )}
                  </resetForm.Field>
                  <div className="flex items-center justify-between pt-2">
                    <button type="button" className={LINK} onClick={() => switchTo("signIn")}>
                      Back to login
                    </button>
                    <SubmitButton pending={pending} label="Set password" />
                  </div>
                </PanelFrame>
              )}

              {mode === "otp" && !email && (
                <PanelFrame formKey="otp-email" onSubmit={submit(otpEmailForm)}>
                  <Hint>We will email you a one-time sign-in code.</Hint>
                  <otpEmailForm.Field
                    name="email"
                    validators={{ onSubmit: otpEmailSchema.shape.email }}
                  >
                    {(field) => (
                      <div>
                        <div className={FIELD_ROW}>
                          <Mail className="h-5 w-5 text-[#86868B]" />
                          <input
                            id="otp-email"
                            name="email"
                            type="email"
                            autoComplete="email"
                            placeholder="Email Address"
                            aria-label="Email Address"
                            className={FIELD_INPUT}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                          />
                        </div>
                        <FieldError errors={field.state.meta.errors} />
                      </div>
                    )}
                  </otpEmailForm.Field>
                  <div className="flex items-center justify-between pt-2">
                    <button type="button" className={LINK} onClick={() => switchTo("signIn")}>
                      Back to login
                    </button>
                    <SubmitButton pending={pending} label="Send code" />
                  </div>
                </PanelFrame>
              )}

              {mode === "otp" && email && (
                <PanelFrame formKey="otp-code" onSubmit={submit(otpCodeForm)}>
                  <Hint>
                    Enter the code sent to <span className="font-medium">{email}</span>.
                  </Hint>
                  <otpCodeForm.Field
                    name="code"
                    validators={{ onSubmit: otpCodeSchema.shape.code }}
                  >
                    {(field) => (
                      <div>
                        <div className={FIELD_ROW}>
                          <KeyRound className="h-5 w-5 text-[#86868B]" />
                          <input
                            id="otp-code"
                            name="code"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            placeholder="One-time code"
                            aria-label="One-time code"
                            className={FIELD_INPUT}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                          />
                        </div>
                        <FieldError errors={field.state.meta.errors} />
                      </div>
                    )}
                  </otpCodeForm.Field>
                  <div className="flex items-center justify-between pt-2">
                    <button
                      type="button"
                      className={LINK}
                      onClick={() => {
                        setEmail("");
                        switchTo("signIn");
                      }}
                    >
                      Back to login
                    </button>
                    <SubmitButton pending={pending} label="Continue" />
                  </div>
                </PanelFrame>
              )}
            </AnimatePresence>
          </div>

          <OAuthRow onGoogle={() => void signIn("google")} disabled={pending} />
        </div>
      </div>
    </div>
  );
}
