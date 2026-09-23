"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { OllaSuperBrand } from "@/components/branding";
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
  User,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { consumeDisplacedFlag } from "@/lib/displaced-session";
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

type Mode = "signIn" | "signUp" | "verify" | "forgot" | "reset" | "otp";

// Field heights are a touch-target floor, not a taste call: qa-responsive.js
// measures every interactive element on a coarse pointer against 44px.
const LABEL = "mb-1.5 block font-medium text-[13px] text-foreground";
const FIELD_ROW =
  "flex min-h-[50px] items-center gap-3 rounded-xl border border-border bg-card px-3.5 transition-colors focus-within:border-foreground focus-within:ring-1 focus-within:ring-ring";
const FIELD_INPUT =
  // min-h so the INPUT is the tap target, not just the 23px line box inside a
  // 50px row: tapping a row's padding focuses nothing, the row is not a label.
  "min-h-[46px] w-full bg-transparent text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none";
const SUBMIT =
  "group flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl bg-foreground px-6 font-semibold text-[14px] text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-40";
const LINK =
  // py-1 takes these 20px text links to 28px of hit area, clearing WCAG 2.2 AA
  // 2.5.8 (24px). Vertical padding on an inline box does not move a line, so
  // nothing shifts.
  "py-1 font-medium text-foreground text-[13px] underline underline-offset-4 transition-opacity hover:opacity-70";
// Was the app's only gradient TEXT (four stops via bg-clip-text). One ink now.


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
  return <span className="mt-1.5 inline-block font-medium text-[11px] text-destructive">{first}</span>;
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
      // Pre-hydration submit. Until React attaches onSubmit, Enter performs
      // the browser's native submission, and a form with no method submits
      // as GET — the email AND password land in the URL, the history, and
      // every access log on the path. Seen from India-throttled Chrome, where
      // typing outran hydration. A POST puts nothing in the URL; the server
      // answers it with this same page (200), so the user simply sees the
      // form again. After hydration onSubmit preventDefaults, unchanged.
      method="post"
      className="space-y-5"
    >
      {children}
    </m.form>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-xs">{children}</p>;
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
      {/*
        ONE centred column on a plain page — no split panel, no card.

        min-h-screen and NOT .h-dvh-safe (a fixed 100dvh): the sign-up and reset
        panels are taller than a short phone, and a fixed height would clip them
        with nothing to scroll. For the same reason there is no overflow-hidden
        here and NO min-h-0 on <main> — a flex item keeps min-height:auto, so a
        tall panel grows the page and the document scrolls, instead of being
        centred into an overflow that cannot be scrolled back up to.
      */}
      <div className="flex min-h-screen w-full flex-col bg-background font-sans">
        {/*
          STICKY, NOT FIXED. Sticky keeps the header in normal flow — it still
          reserves its own space — so at the top of the page it cannot sit on
          top of the form the way a fixed (or absolute) mark would, which
          qa-responsive.js reports as a covered control. It only pins once the
          page actually scrolls, which is what a tall panel on a short phone
          does. bg-background + z-10 so the form passes UNDER it rather than
          through it. Deliberately not a link: no extra tab stop and no new
          navigation target on the sign-in page.
        */}
        <header className="sticky top-0 z-10 shrink-0 bg-background px-5 py-5 sm:px-8 sm:py-7">
          <OllaSuperBrand
            variant="auth"
            className="gap-2.5 text-foreground"
            markClassName="h-7 w-7 sm:h-8 sm:w-8"
            textClassName="text-[21px] sm:text-[23px]"
          />
        </header>

        <main className="flex w-full flex-1 items-center justify-center px-5 pb-16 sm:px-8 sm:pb-24">
          {/* max-w-md is the width the form column already had, so the three-up
              social row keeps the horizontal maths that passes at 375px. */}
          <div className="w-full max-w-md">
            <div className="mb-8 text-center">
              {/* No text-transform: renders copy verbatim ("Welcome back"). */}
              <h1 className="font-bold text-[30px] leading-tight tracking-[-0.01em] text-foreground sm:text-[34px]">
                {copy[mode].title}
              </h1>
              <p className="mt-2 text-[14px] text-muted-foreground sm:text-[15px]">
                {copy[mode].sub}
              </p>
            </div>

            {/* mode="wait" is load-bearing, not decorative: e2e/p2-auth.js fills
                input[type="email"] without .first(), so two mounted forms would
                be a Playwright strict-mode violation. */}
            {/* initial={false}: without it framer-motion serialises the first
                panel as opacity:0 translateX(18px) INTO THE SERVER HTML, so the
                fields are invisible until the motion chunk hydrates. The old
                branding column hid that; on a centred page it is the whole
                screen. Mode SWITCHES still animate. */}
            <AnimatePresence mode="wait" initial={false}>
              {mode === "signIn" && (
                <PanelFrame formKey="signIn" onSubmit={submit(signInForm)}>
                  <signInForm.Field name="email" validators={{ onSubmit: signInSchema.shape.email }}>
                    {(field) => (
                      <FieldShell label="Email address" htmlFor="email" errors={field.state.meta.errors}>
                        <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                        <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                          className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
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
                        <User className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                        <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                        <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                          className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
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
                    Code sent to <span className="font-medium text-muted-foreground">{email}</span>
                  </Hint>
                  <verifyForm.Field name="code" validators={{ onSubmit: verifySchema.shape.code }}>
                    {(field) => (
                      <FieldShell
                        label="Verification code"
                        htmlFor="verify-code"
                        errors={field.state.meta.errors}
                      >
                        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                        <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                    Reset code sent to <span className="font-medium text-muted-foreground">{email}</span>
                  </Hint>
                  <resetForm.Field name="code" validators={{ onSubmit: resetSchema.shape.code }}>
                    {(field) => (
                      <FieldShell
                        label="Reset code"
                        htmlFor="reset-code"
                        errors={field.state.meta.errors}
                      >
                        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                        <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                          className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
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
                        <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                    Code sent to <span className="font-medium text-muted-foreground">{email}</span>
                  </Hint>
                  <otpCodeForm.Field name="code" validators={{ onSubmit: otpCodeSchema.shape.code }}>
                    {(field) => (
                      <FieldShell
                        label="One-time code"
                        htmlFor="otp-code"
                        errors={field.state.meta.errors}
                      >
                        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
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
              <span className="h-px flex-1 bg-border" />
              <span className="font-semibold text-[11px] text-muted-foreground uppercase tracking-widest">
                or
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <OAuthRow onGoogle={() => void signIn("google")} disabled={pending} />

            {/* Mode-aware bottom link — replaces the removed Login/Sign-up tabs.
                Only calls setMode; lives outside AnimatePresence. */}
            {mode === "signIn" && (
              <p className="mt-6 text-center text-[13px] text-muted-foreground">
                New to OllaSuper?{" "}
                <button type="button" className={LINK} onClick={() => setMode("signUp")}>
                  Create an account →
                </button>
              </p>
            )}
            {mode === "signUp" && (
              <p className="mt-6 text-center text-[13px] text-muted-foreground">
                Already have an account?{" "}
                <button type="button" className={LINK} onClick={() => setMode("signIn")}>
                  Sign in
                </button>
              </p>
            )}
          </div>
        </main>
      </div>
    </LazyMotion>
  );
}
