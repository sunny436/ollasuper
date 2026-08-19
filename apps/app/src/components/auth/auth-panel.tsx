"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@v1/backend/convex/_generated/api";
import { useAction } from "convex/react";
import { useForm } from "@tanstack/react-form";
import { zodValidator } from "@tanstack/zod-form-adapter";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  Sparkles,
  User,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AmbientBackdrop } from "./ambient-backdrop";
import { consumeDisplacedFlag } from "@/lib/displaced-session";
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

// three.js is ~150kB gzipped and this is the app's entry page, so it loads only
// after hydration and never lands in the login route's first-load bundle.
// ssr:false is legal here and only here — this file is a client component.
const IntelligenceCore = dynamic(
  () => import("./intelligence-core").then((m) => m.IntelligenceCore),
  { ssr: false, loading: () => <IntelligenceCoreFallback /> },
);

// Rendered during SSR too, so it cannot be new Date().getFullYear() without
// risking a hydration mismatch across a year boundary.
const COPYRIGHT_YEAR = 2026;

type Mode = "signIn" | "signUp" | "verify" | "forgot" | "reset" | "otp";

const LABEL = "mb-2 block font-semibold text-[11px] text-white/60 uppercase tracking-[0.12em]";
const FIELD_ROW =
  "flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 transition-colors focus-within:border-[#06B6D4]/60 focus-within:bg-white/[0.06]";
const FIELD_INPUT =
  "w-full bg-transparent font-medium text-sm text-white placeholder-white/25 focus:outline-none";
const SUBMIT =
  "group flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#22C1E8] to-[#7C3AED] px-8 py-3.5 font-bold text-[13px] text-white uppercase tracking-[0.14em] shadow-[0_8px_30px_rgba(6,182,212,0.35)] transition-all hover:shadow-[0_10px_38px_rgba(124,58,237,0.45)] disabled:opacity-60";
const LINK = "font-semibold text-[#22C1E8] text-xs transition-colors hover:text-[#5AD8FA]";

// ---------------------------------------------------------------------------
// Every sub-component below lives at MODULE SCOPE. Defining one inside the panel
// gives it a fresh identity on each render, so React unmounts and remounts the
// inputs on every keystroke — the field loses focus after one character. Same
// bug documented in chat's composer.tsx.
// ---------------------------------------------------------------------------

function FieldError({ errors }: { errors: unknown[] }) {
  const first = errors.find((e): e is string => typeof e === "string" && e.length > 0);
  if (!first) return null;
  return <span className="mt-1.5 inline-block font-medium text-[11px] text-rose-400">{first}</span>;
}

function SubmitButton({ pending, label }: { pending: boolean; label: string }) {
  return (
    <button type="submit" disabled={pending} className={SUBMIT}>
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <>
          {label}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </>
      )}
    </button>
  );
}

function TabButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: typeof User;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-3 rounded-xl px-5 py-4 text-left font-bold text-sm uppercase tracking-[0.14em] transition-colors duration-300 ${
          active ? "text-white" : "text-white/45 hover:text-white/80"
        }`}
      >
        <Icon className="relative z-10 h-4 w-4" />
        <span className="relative z-10 flex-1">{label}</span>
        {active && <ArrowRight className="relative z-10 h-4 w-4" />}
      </button>
      {active && (
        <motion.div
          layoutId="activeTabNotch"
          className="absolute inset-0 rounded-xl border border-white/15 bg-white/10 shadow-lg backdrop-blur-sm"
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
      initial={{ opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -18 }}
      transition={{ duration: 0.25 }}
      onSubmit={onSubmit}
      className="space-y-5"
    >
      {children}
    </motion.form>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-white/45 text-xs">{children}</p>;
}

/** Shared shell for a labelled input so every field looks identical. */
function FieldShell({
  label,
  htmlFor,
  errors,
  action,
  children,
}: {
  label: string;
  htmlFor: string;
  errors: unknown[];
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className={LABEL} htmlFor={htmlFor}>
          {label}
        </label>
        {action}
      </div>
      <div className={FIELD_ROW}>{children}</div>
      <FieldError errors={errors} />
    </div>
  );
}

export function AuthPanel() {
  const { signIn } = useAuthActions();
  const router = useRouter();
  // NOT signIn("password", { flow: "reset" }): that resolves for a known address
  // and throws InvalidAccountId for an unknown one, which is an enumeration
  // oracle. This action responds identically either way.
  const requestPasswordReset = useAction(api.authSessions.requestPasswordReset);
  const [mode, setMode] = useState<Mode>("signIn");
  const [pending, setPending] = useState(false);
  const [reveal, setReveal] = useState(false);
  // Carried across steps: the verify and reset panels need the address the code
  // went to, and the user should not have to retype it.
  const [email, setEmail] = useState("");

  // Explain an involuntary sign-out. Without this, a user displaced by a login
  // on another device just finds themselves at a login screen with no reason.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per mount
  useEffect(() => {
    if (consumeDisplacedFlag()) {
      toast.error("You were signed out because your account was used on another device.");
    }
  }, []);

  /**
   * Lifted from the original auth-form.tsx. ConvexError puts the server's
   * message on `.data` — that is how the password-policy text reaches the user —
   * with `.message` as the fallback for transport-level failures.
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

  /**
   * Land the user in the app after a flow that actually completes a sign-in.
   *
   * Without this the app relied on an accident: signIn triggers an RSC refresh
   * of /login, middleware 307s to "/", and only the server-side redirect("/chat")
   * inside (dashboard)/page.tsx finally makes the router commit. Measured on
   * production that took 4.6s from clicking submit to landing on /chat. The
   * middleware redirect is still there for anyone who opens /login while already
   * signed in; this just stops a fresh sign-in waiting on it.
   */
  const enter = () => router.replace("/chat");

  const signInForm = useForm({
    validatorAdapter: zodValidator(),
    defaultValues: { email: "", password: "" },
    onSubmit: ({ value }) =>
      go(async () => {
        await signIn("password", { ...value, flow: "signIn" });
        enter();
      })(),
  });

  const signUpForm = useForm({
    validatorAdapter: zodValidator(),
    defaultValues: { name: "", email: "", password: "" },
    onSubmit: ({ value }) =>
      go(async () => {
        // `name` reaches users.name only because convex/auth.ts defines a
        // `profile` function; the provider's default drops everything but email.
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
        enter();
      })(),
  });

  const forgotForm = useForm({
    validatorAdapter: zodValidator(),
    defaultValues: { email: "" },
    onSubmit: ({ value }) =>
      go(async () => {
        await requestPasswordReset({ email: value.email });
        setEmail(value.email);
        // Deliberately generic: says nothing about whether the account exists.
        toast.success("If that account exists, a reset code is on its way.");
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
        enter();
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
        enter();
      })(),
  });

  const submit = (form: { handleSubmit: () => void }) => (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    form.handleSubmit();
  };

  const copy: Record<Mode, { title: string; sub: string }> = {
    signIn: { title: "Welcome back", sub: "Enter your credentials to access your workspace" },
    signUp: { title: "Create account", sub: "Set up your Ollasuper workspace in seconds" },
    verify: { title: "Verify email", sub: "We sent a one-time code to confirm it is you" },
    forgot: { title: "Reset password", sub: "We will email you a code to set a new password" },
    reset: { title: "New password", sub: "Enter the code and choose a new password" },
    otp: { title: "Email code", sub: "Sign in with a one-time code, no password needed" },
  };

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-[#07080E] p-4 font-sans selection:bg-[#7C3AED]/40 selection:text-white md:p-8">
      <AmbientBackdrop />

      {/* Neon halo sits behind the card, hence -inset and -z-10. */}
      <div className="relative">
        <div className="pointer-events-none absolute -inset-8 -z-10 rounded-[40px] bg-gradient-to-r from-cyan-500/20 via-purple-600/20 to-pink-500/20 blur-[70px]" />
        <div className="relative flex min-h-[620px] w-full max-w-[980px] flex-col overflow-hidden rounded-[28px] border border-white/10 bg-white/[0.03] shadow-[0_30px_90px_rgba(0,0,0,0.65)] backdrop-blur-2xl md:flex-row">
        {/* Left brand panel */}
        <div className="relative flex w-full select-none flex-col justify-between overflow-hidden border-white/10 bg-gradient-to-br from-[#12203F] via-[#1B1B44] to-[#3B1B5E] p-8 md:w-[340px] md:border-r md:p-10">
          <div className="pointer-events-none absolute -inset-[40%] opacity-20 mix-blend-overlay">
            <div className="absolute -left-[20%] top-[18%] h-[110px] w-[200%] rotate-[-35deg] bg-white/70" />
            <div className="absolute -left-[20%] top-[48%] h-[150px] w-[200%] rotate-[-35deg] bg-cyan-300/60" />
            <div className="absolute -left-[20%] top-[76%] h-[95px] w-[200%] rotate-[-35deg] bg-fuchsia-400/60" />
          </div>

          <div className="relative z-10">
            <div className="flex items-center gap-3">
              <span className="font-black text-2xl text-[#5AD8FA] tracking-[0.06em]">OLLASUPER</span>
              <span className="flex items-center gap-1 rounded-full border border-[#22C1E8]/40 bg-[#22C1E8]/10 px-2.5 py-1 font-bold text-[10px] text-[#5AD8FA] uppercase tracking-widest">
                <Sparkles className="h-2.5 w-2.5" />
                AI V2.0
              </span>
            </div>
            <p className="mt-2 font-medium text-white/50 text-xs">
              All-In-One Super Intelligence Workspace
            </p>
          </div>

          <div className="relative z-20 my-10 flex flex-col gap-3 md:my-0">
            <TabButton
              label="Login"
              icon={User}
              active={mode === "signIn"}
              onClick={() => setMode("signIn")}
            />
            <TabButton
              label="Sign up"
              icon={Sparkles}
              active={mode === "signUp"}
              onClick={() => setMode("signUp")}
            />
          </div>

          <div className="relative z-10 flex items-center justify-between border-white/10 border-t pt-5 text-[11px] text-white/40">
            <span>&copy; {COPYRIGHT_YEAR} Ollasuper Workspaces</span>
            <span className="flex items-center gap-1.5 text-[#5AD8FA]/80">
              <ShieldCheck className="h-3 w-3" /> Convex Auth
            </span>
          </div>
        </div>

        {/* Right form panel */}
        <div className="relative z-10 flex flex-1 flex-col justify-between p-8 md:p-12">
          <div className="mb-8 flex flex-col items-center text-center">
            <div className="relative flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-tr from-[#06B6D4] via-[#7C3AED] to-[#EC4899] p-[3px] shadow-[0_0_50px_rgba(6,182,212,0.55)]">
              <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border border-white/20 bg-[#0D0E15]">
                <IntelligenceCore />
              </div>
            </div>
            <h1 className="mt-6 font-black text-3xl text-white uppercase tracking-[0.08em]">
              {copy[mode].title}
            </h1>
            <p className="mt-2 text-sm text-white/45">{copy[mode].sub}</p>
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
                      <FieldShell label="Email address" htmlFor="email" errors={field.state.meta.errors}>
                        <Mail className="h-4 w-4 shrink-0 text-white/35" />
                        <input
                          id="email"
                          name="email"
                          type="email"
                          autoComplete="email"
                          placeholder="name@company.com"
                          className={FIELD_INPUT}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      </FieldShell>
                    )}
                  </signInForm.Field>

                  <signInForm.Field
                    name="password"
                    validators={{ onSubmit: signInSchema.shape.password }}
                  >
                    {(field) => (
                      <FieldShell
                        label="Password"
                        htmlFor="password"
                        errors={field.state.meta.errors}
                        action={
                          <button type="button" className={LINK} onClick={() => setMode("forgot")}>
                            Forgot?
                          </button>
                        }
                      >
                        <Lock className="h-4 w-4 shrink-0 text-white/35" />
                        <input
                          id="password"
                          name="password"
                          type={reveal ? "text" : "password"}
                          autoComplete="current-password"
                          placeholder="••••••••••••"
                          className={FIELD_INPUT}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                        <button
                          type="button"
                          aria-label={reveal ? "Hide password" : "Show password"}
                          onClick={() => setReveal((v) => !v)}
                          className="shrink-0 text-white/35 transition-colors hover:text-white/70"
                        >
                          {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </FieldShell>
                    )}
                  </signInForm.Field>

                  <SubmitButton pending={pending} label="Enter workspace" />
                  <button type="button" className={`${LINK} block`} onClick={() => setMode("otp")}>
                    Sign in with a one-time email code
                  </button>
                </PanelFrame>
              )}

              {mode === "signUp" && (
                <PanelFrame formKey="signUp" onSubmit={submit(signUpForm)}>
                  <signUpForm.Field name="name" validators={{ onSubmit: signUpSchema.shape.name }}>
                    {(field) => (
                      <FieldShell label="Full name" htmlFor="name" errors={field.state.meta.errors}>
                        <User className="h-4 w-4 shrink-0 text-white/35" />
                        <input
                          id="name"
                          name="name"
                          type="text"
                          autoComplete="name"
                          placeholder="Ada Lovelace"
                          className={FIELD_INPUT}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      </FieldShell>
                    )}
                  </signUpForm.Field>

                  <signUpForm.Field name="email" validators={{ onSubmit: signUpSchema.shape.email }}>
                    {(field) => (
                      <FieldShell
                        label="Email address"
                        htmlFor="signup-email"
                        errors={field.state.meta.errors}
                      >
                        <Mail className="h-4 w-4 shrink-0 text-white/35" />
                        <input
                          id="signup-email"
                          name="email"
                          type="email"
                          autoComplete="email"
                          placeholder="name@company.com"
                          className={FIELD_INPUT}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      </FieldShell>
                    )}
                  </signUpForm.Field>

                  <signUpForm.Field
                    name="password"
                    validators={{ onSubmit: signUpSchema.shape.password }}
                  >
                    {(field) => (
                      <FieldShell
                        label="Password"
                        htmlFor="signup-password"
                        errors={field.state.meta.errors}
                      >
                        <Lock className="h-4 w-4 shrink-0 text-white/35" />
                        <input
                          id="signup-password"
                          name="password"
                          type={reveal ? "text" : "password"}
                          autoComplete="new-password"
                          placeholder="At least 8 characters"
                          className={FIELD_INPUT}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                        <button
                          type="button"
                          aria-label={reveal ? "Hide password" : "Show password"}
                          onClick={() => setReveal((v) => !v)}
                          className="shrink-0 text-white/35 transition-colors hover:text-white/70"
                        >
                          {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </FieldShell>
                    )}
                  </signUpForm.Field>

                  <Hint>Upper and lowercase letters plus a number.</Hint>
                  <SubmitButton pending={pending} label="Create workspace" />
                </PanelFrame>
              )}

              {mode === "verify" && (
                <PanelFrame formKey="verify" onSubmit={submit(verifyForm)}>
                  <Hint>
                    Code sent to <span className="font-medium text-white/70">{email}</span>
                  </Hint>
                  <verifyForm.Field name="code" validators={{ onSubmit: verifySchema.shape.code }}>
                    {(field) => (
                      <FieldShell
                        label="Verification code"
                        htmlFor="verify-code"
                        errors={field.state.meta.errors}
                      >
                        <KeyRound className="h-4 w-4 shrink-0 text-white/35" />
                        <input
                          id="verify-code"
                          name="code"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder="00000000"
                          className={FIELD_INPUT}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      </FieldShell>
                    )}
                  </verifyForm.Field>
                  <SubmitButton pending={pending} label="Verify email" />
                  <button type="button" className={`${LINK} block`} onClick={() => setMode("signIn")}>
                    Back to login
                  </button>
                </PanelFrame>
              )}

              {mode === "forgot" && (
                <PanelFrame formKey="forgot" onSubmit={submit(forgotForm)}>
                  <forgotForm.Field name="email" validators={{ onSubmit: forgotSchema.shape.email }}>
                    {(field) => (
                      <FieldShell
                        label="Email address"
                        htmlFor="forgot-email"
                        errors={field.state.meta.errors}
                      >
                        <Mail className="h-4 w-4 shrink-0 text-white/35" />
                        <input
                          id="forgot-email"
                          name="email"
                          type="email"
                          autoComplete="email"
                          placeholder="name@company.com"
                          className={FIELD_INPUT}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      </FieldShell>
                    )}
                  </forgotForm.Field>
                  <SubmitButton pending={pending} label="Send reset code" />
                  <button type="button" className={`${LINK} block`} onClick={() => setMode("signIn")}>
                    Back to login
                  </button>
                </PanelFrame>
              )}

              {mode === "reset" && (
                <PanelFrame formKey="reset" onSubmit={submit(resetForm)}>
                  <Hint>
                    Reset code sent to <span className="font-medium text-white/70">{email}</span>
                  </Hint>
                  <resetForm.Field name="code" validators={{ onSubmit: resetSchema.shape.code }}>
                    {(field) => (
                      <FieldShell
                        label="Reset code"
                        htmlFor="reset-code"
                        errors={field.state.meta.errors}
                      >
                        <KeyRound className="h-4 w-4 shrink-0 text-white/35" />
                        <input
                          id="reset-code"
                          name="code"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder="00000000"
                          className={FIELD_INPUT}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      </FieldShell>
                    )}
                  </resetForm.Field>
                  <resetForm.Field
                    name="newPassword"
                    validators={{ onSubmit: resetSchema.shape.newPassword }}
                  >
                    {(field) => (
                      <FieldShell
                        label="New password"
                        htmlFor="reset-password"
                        errors={field.state.meta.errors}
                      >
                        <Lock className="h-4 w-4 shrink-0 text-white/35" />
                        <input
                          id="reset-password"
                          name="newPassword"
                          type={reveal ? "text" : "password"}
                          autoComplete="new-password"
                          placeholder="At least 8 characters"
                          className={FIELD_INPUT}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                        <button
                          type="button"
                          aria-label={reveal ? "Hide password" : "Show password"}
                          onClick={() => setReveal((v) => !v)}
                          className="shrink-0 text-white/35 transition-colors hover:text-white/70"
                        >
                          {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </FieldShell>
                    )}
                  </resetForm.Field>
                  <SubmitButton pending={pending} label="Set password" />
                  <button type="button" className={`${LINK} block`} onClick={() => setMode("signIn")}>
                    Back to login
                  </button>
                </PanelFrame>
              )}

              {mode === "otp" && !email && (
                <PanelFrame formKey="otp-email" onSubmit={submit(otpEmailForm)}>
                  <otpEmailForm.Field
                    name="email"
                    validators={{ onSubmit: otpEmailSchema.shape.email }}
                  >
                    {(field) => (
                      <FieldShell
                        label="Email address"
                        htmlFor="otp-email"
                        errors={field.state.meta.errors}
                      >
                        <Mail className="h-4 w-4 shrink-0 text-white/35" />
                        <input
                          id="otp-email"
                          name="email"
                          type="email"
                          autoComplete="email"
                          placeholder="name@company.com"
                          className={FIELD_INPUT}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      </FieldShell>
                    )}
                  </otpEmailForm.Field>
                  <SubmitButton pending={pending} label="Send code" />
                  <button type="button" className={`${LINK} block`} onClick={() => setMode("signIn")}>
                    Back to login
                  </button>
                </PanelFrame>
              )}

              {mode === "otp" && email && (
                <PanelFrame formKey="otp-code" onSubmit={submit(otpCodeForm)}>
                  <Hint>
                    Code sent to <span className="font-medium text-white/70">{email}</span>
                  </Hint>
                  <otpCodeForm.Field name="code" validators={{ onSubmit: otpCodeSchema.shape.code }}>
                    {(field) => (
                      <FieldShell
                        label="One-time code"
                        htmlFor="otp-code"
                        errors={field.state.meta.errors}
                      >
                        <KeyRound className="h-4 w-4 shrink-0 text-white/35" />
                        <input
                          id="otp-code"
                          name="code"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder="00000000"
                          className={FIELD_INPUT}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      </FieldShell>
                    )}
                  </otpCodeForm.Field>
                  <SubmitButton pending={pending} label="Continue" />
                  <button
                    type="button"
                    className={`${LINK} block`}
                    onClick={() => {
                      setEmail("");
                      setMode("signIn");
                    }}
                  >
                    Back to login
                  </button>
                </PanelFrame>
              )}
            </AnimatePresence>
          </div>

          <OAuthRow onGoogle={() => void signIn("google")} disabled={pending} />
        </div>
        </div>
      </div>
    </div>
  );
}
