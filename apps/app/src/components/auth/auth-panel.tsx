"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@v1/backend/convex/_generated/api";
import { useAction } from "convex/react";
import { useForm } from "@tanstack/react-form";
import { zodValidator } from "@tanstack/zod-form-adapter";
import { AnimatePresence, LazyMotion, m } from "framer-motion";
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
  Users,
  Zap,
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
  "flex min-h-[62px] items-center gap-3.5 rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-4 transition-colors focus-within:border-[#06B6D4]/60 focus-within:bg-white/[0.06]";
const FIELD_INPUT =
  "w-full bg-transparent font-medium text-[15px] text-white placeholder-white/25 focus:outline-none";
const SUBMIT =
  "group flex min-h-[64px] w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[#22C1E8] via-[#4F8BF0] to-[#7C3AED] px-8 py-4 font-bold text-sm text-white uppercase tracking-[0.14em] shadow-[0_10px_40px_rgba(6,182,212,0.4)] transition-all hover:shadow-[0_14px_48px_rgba(124,58,237,0.5)] disabled:opacity-60";
const LINK = "font-semibold text-[#22C1E8] text-[13px] transition-colors hover:text-[#5AD8FA]";
// The one gradient-TEXT in the app (no bg-clip-text existed before). Needs BOTH
// bg-clip-text and text-transparent or it renders as solid text. Four colour
// stops → arbitrary linear-gradient, since from/via/to only expresses three.
const WORDMARK =
  "bg-[linear-gradient(90deg,#22D3EE_0%,#4F8BF0_34%,#7C3AED_66%,#EC4899_100%)] bg-clip-text font-black text-3xl italic uppercase tracking-tight text-transparent";

// ---------------------------------------------------------------------------
// Every sub-component below lives at MODULE SCOPE. Defining one inside the panel
// gives it a fresh identity on each render, so React unmounts and remounts the
// inputs on every keystroke — the field loses focus after one character. Same
// bug documented in chat's composer.tsx.
// ---------------------------------------------------------------------------

// Loader (not the object) so LazyMotion code-splits the feature bundle out of
// the login route's first-load JS. See ./motion-features.
const loadMotionFeatures = () =>
  import("./motion-features").then((mod) => mod.default);

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

/** One cell of the left-column 2×2 feature grid. Module scope like the rest. */
function FeatureCard({
  icon: Icon,
  title,
  desc,
  accent,
}: {
  icon: typeof Sparkles;
  title: string;
  desc: string;
  accent: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-[#7C3AED]/15 bg-white/[0.03] p-4 backdrop-blur-sm transition-colors hover:border-[#7C3AED]/30">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]">
        <Icon className={`h-4 w-4 ${accent}`} />
      </span>
      <p className="font-semibold text-[13px] text-white">{title}</p>
      <p className="text-[11px] leading-snug text-white/45">{desc}</p>
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
    <m.form
      key={formKey}
      initial={{ opacity: 0, x: 18 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -18 }}
      transition={{ duration: 0.25 }}
      onSubmit={onSubmit}
      className="space-y-5"
    >
      {children}
    </m.form>
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
    // NOT the shared go(): login must NEVER reveal whether the email exists or
    // which field was wrong. The server already collapses unknown-email and
    // wrong-password into one error; this collapses everything else too, showing
    // a single generic message (only the rate-limit case is surfaced distinctly).
    onSubmit: ({ value }) =>
      (async () => {
        setPending(true);
        try {
          await signIn("password", { ...value, flow: "signIn" });
          enter();
        } catch (err) {
          const t = String(
            (err as { data?: unknown })?.data ?? (err as Error)?.message ?? "",
          ).toLowerCase();
          toast.error(
            /too many|attempt|rate.?limit/.test(t)
              ? "Too many attempts. Please wait and try again."
              : "Invalid email or password.",
          );
        } finally {
          setPending(false);
        }
      })(),
  });

  const signUpForm = useForm({
    validatorAdapter: zodValidator(),
    defaultValues: { name: "", email: "", password: "" },
    // Not the shared go(): a specific validation error (domain / password policy)
    // is a ConvexError with `.data` and SHOULD be shown; anything else — in
    // particular "account already exists" — must present the IDENTICAL
    // "check your email" outcome as a fresh sign-up, so sign-up never reveals
    // whether the address is registered.
    onSubmit: ({ value }) =>
      (async () => {
        setPending(true);
        const toVerify = () => {
          setEmail(value.email);
          // Deliberately covers BOTH outcomes in one constant sentence. A
          // sign-up against an address that already exists now sends nothing
          // at all (see convex/passwordProvider.ts), so a message promising a
          // code would strand the real owner on this screen — while any
          // message that distinguished the two cases would re-open the
          // enumeration oracle the silence exists to close.
          toast.success(
            "If that address is new, your code is on the way. Already registered? Use Forgot password.",
          );
          setMode("verify");
        };
        try {
          // `name` reaches users.name only because convex/auth.ts defines a
          // `profile` function; the provider's default drops all but email.
          await signIn("password", { ...value, flow: "signUp" });
          toVerify();
        } catch (err) {
          const data = (err as { data?: unknown })?.data;
          if (typeof data === "string") {
            toast.error(data); // specific, user-friendly validation message
          } else {
            toVerify(); // non-revealing: same as a new sign-up
          }
        } finally {
          setPending(false);
        }
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
    signUp: {
      title: "Your Intelligence Starts Here",
      sub: "Create your workspace and bring your ideas to life.",
    },
    verify: { title: "Verify email", sub: "We sent a one-time code to confirm it is you" },
    forgot: { title: "Reset password", sub: "We will email you a code to set a new password" },
    reset: { title: "New password", sub: "Enter the code and choose a new password" },
    otp: { title: "Email code", sub: "Sign in with a one-time code, no password needed" },
  };

  return (
    <LazyMotion features={loadMotionFeatures}>
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-[#07080E] p-4 font-sans selection:bg-[#7C3AED]/40 selection:text-white md:p-8">
      <AmbientBackdrop />

      {/* Near-full-page auth shell; the neon halo sits behind it (-inset, -z-10). */}
      <div className="relative h-auto w-[92vw] max-w-[1360px] md:h-[86vh] md:max-h-[860px]">
        {/* A rounded-rect glow: no filter-free equivalent, so touch devices (see the
            no-live-blur rule in globals.css) skip it; the card keeps its own shadow. */}
        <div className="pointer-events-none absolute -inset-8 -z-10 hidden rounded-[44px] bg-gradient-to-r from-cyan-500/20 via-purple-600/20 to-pink-500/20 blur-[70px] [@media(pointer:fine)]:block" />
        <div className="relative flex h-full w-full flex-col overflow-hidden rounded-[32px] border border-white/10 bg-white/[0.03] shadow-[0_30px_90px_rgba(0,0,0,0.65)] backdrop-blur-2xl md:flex-row">

        {/* ===== LEFT: constant branding for every mode (no tab nav, no AI pill) ===== */}
        <div className="relative flex w-full select-none flex-col items-center justify-between overflow-hidden border-[#4F8BF0]/10 p-8 md:w-1/2 md:overflow-y-auto md:border-r md:p-10">
          {/* Subtle orbital / radial art — behind content, never overlapping. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -z-0 bg-[radial-gradient(circle_at_50%_28%,rgba(124,58,237,0.14),transparent_60%)]"
          />

          {/* Top: reused orb housing (VERBATIM) + wordmark + divider + taglines. */}
          <div className="relative z-10 flex flex-col items-center gap-5">
            <div className="relative flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-tr from-[#06B6D4] via-[#7C3AED] to-[#EC4899] p-[3px] shadow-[0_0_50px_rgba(6,182,212,0.55)]">
              <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border border-white/20 bg-[#0D0E15]">
                <IntelligenceCore />
              </div>
            </div>

            <span className={WORDMARK}>OLLASUPER</span>

            {/* ──── ✦ ──── */}
            <div className="flex items-center gap-3">
              <span className="h-px w-12 bg-gradient-to-r from-transparent to-white/25" />
              <span className="text-[11px] text-[#5AD8FA] drop-shadow-[0_0_6px_rgba(90,216,250,0.7)]">
                ✦
              </span>
              <span className="h-px w-12 bg-gradient-to-l from-transparent to-white/25" />
            </div>

            <div className="text-center">
              <p className="font-semibold text-[20px] text-white">
                All-in-One Super Intelligence Workspace
              </p>
              <p className="mt-2 text-[15px] text-white/45">
                AI tools for creators, builders &amp; dreamers.
              </p>
            </div>
          </div>

          {/* Middle: 2×2 feature cards (desktop only). */}
          <div className="relative z-10 my-8 hidden w-full max-w-sm grid-cols-2 gap-3 md:grid">
            <FeatureCard
              icon={Zap}
              title="Super Fast"
              desc="AI that works as fast as you think"
              accent="text-[#5AD8FA]"
            />
            <FeatureCard
              icon={Sparkles}
              title="All-in-One"
              desc="Everything you need, in one workspace"
              accent="text-[#4F8BF0]"
            />
            <FeatureCard
              icon={ShieldCheck}
              title="Privacy First"
              desc="Your data, your control, always secure"
              accent="text-[#7C3AED]"
            />
            <FeatureCard
              icon={Users}
              title="Built for Teams"
              desc="Create, collaborate and achieve more"
              accent="text-[#EC4899]"
            />
          </div>

          {/* Footer (desktop only). */}
          <div className="relative z-10 hidden w-full items-center justify-between border-white/10 border-t pt-5 text-[11px] text-white/40 md:flex">
            <span>&copy; {COPYRIGHT_YEAR} Ollasuper Workspaces</span>
            <span className="flex items-center gap-1.5 text-[#5AD8FA]/80">
              <ShieldCheck className="h-3 w-3" /> Convex Auth
            </span>
          </div>
        </div>

        {/* ===== RIGHT: mode-specific form ===== */}
        {/* m-auto (not justify-center) centres the block but lets a tall mode
            scroll from the top instead of clipping it under overflow-y-auto. */}
        <div className="relative z-10 flex flex-1 flex-col overflow-y-auto p-8 md:p-12">
          <div className="m-auto w-full max-w-md">
            <div className="mb-8 text-center">
              {/* No text-transform: renders copy verbatim ("Welcome back"). */}
              <h1 className="font-bold text-[40px] leading-tight text-white">
                {copy[mode].title}
              </h1>
              <p className="mt-2 text-[15px] text-white/45">{copy[mode].sub}</p>
            </div>

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

                  {/* Must list every rule the user has to ACT on, because both
                      validators reject a special-character-less password:
                      signUpPassword (schemas.ts) and assertPasswordRequirements
                      (convex/authPolicy.ts). This previously stopped at "plus a
                      number", so "Password1" read as compliant and was then
                      refused on submit. The 128-char cap and the common-password
                      check are deliberately not listed — neither is something a
                      user can act on up front, and both surface their own
                      message if hit. */}
                  <Hint>
                    Upper and lowercase letters, a number, and a special
                    character.
                  </Hint>
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

            {/* OR divider above the social row. */}
            <div className="my-6 flex items-center gap-4">
              <span className="h-px flex-1 bg-white/10" />
              <span className="font-semibold text-[11px] text-white/30 uppercase tracking-widest">
                or
              </span>
              <span className="h-px flex-1 bg-white/10" />
            </div>

            <OAuthRow onGoogle={() => void signIn("google")} disabled={pending} />

            {/* Mode-aware bottom link — replaces the removed Login/Sign-up tabs.
                Only calls setMode; lives outside AnimatePresence. */}
            {mode === "signIn" && (
              <p className="mt-6 text-center text-[13px] text-white/45">
                New to OllaSuper?{" "}
                <button type="button" className={LINK} onClick={() => setMode("signUp")}>
                  Create an account →
                </button>
              </p>
            )}
            {mode === "signUp" && (
              <p className="mt-6 text-center text-[13px] text-white/45">
                Already have an account?{" "}
                <button type="button" className={LINK} onClick={() => setMode("signIn")}>
                  Sign in
                </button>
              </p>
            )}
          </div>
        </div>
        </div>
      </div>
    </div>
    </LazyMotion>
  );
}
