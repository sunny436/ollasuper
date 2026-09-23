"use client";

/*
 * Third-party identity marks are the ONE place colour survives in the chrome.
 *
 * Google's and Microsoft's logos are trademarks whose brand terms require the
 * official colourways; recolouring them to match this design system would be a
 * trademark violation, not a design decision. Apple's terms say the opposite -
 * the mark must be solid black on light and solid white on dark - which is why
 * it is `text-foreground` and inverts with the theme.
 *
 * The monochrome regression test excludes these marks for the same reason.
 */

const BUTTON =
  "flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 font-medium text-[13px] text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-card";

function GoogleIcon() {
  return (
    <svg data-brand-logo className="h-4 w-4" viewBox="0 0 24 24">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg className="h-4 w-4 fill-current text-foreground" viewBox="0 0 170 170">
      <path d="M150.37 130.25c-2.45 5.66-5.35 10.87-8.71 15.66-4.58 6.53-8.33 11.05-11.22 13.56-4.48 4.12-9.28 6.23-14.42 6.35-3.69 0-8.14-1.05-13.32-3.18-5.19-2.12-9.97-3.17-14.34-3.17-4.58 0-9.49 1.05-14.75 3.17-5.26 2.13-9.5 3.24-12.74 3.35-4.34.13-9.16-1.9-14.49-6.08-3.32-2.62-7.23-7.27-11.73-13.95-6.28-9.28-11.22-19.78-14.82-31.5-3.6-11.72-5.4-23.01-5.4-33.87 0-15.11 3.8-27.46 11.4-37.05 7.6-9.59 17.2-14.48 28.8-14.67 4.74 0 9.87 1.15 15.39 3.45 5.52 2.3 9.4 3.51 11.64 3.63 2.62 0 6.69-1.28 12.22-3.84 5.53-2.56 10.4-3.78 14.61-3.67 11.45.62 20.65 4.87 27.59 12.74-10.23 6.19-15.22 14.9-14.97 26.13.25 8.78 3.61 16.2 10.08 22.25 6.47 6.05 14.28 9.45 23.43 10.2-2.31 6.91-5.43 13.78-9.36 20.61zM119.22 31.84c0-6.72 2.45-13.12 7.35-19.2 4.9-6.08 11.13-10.03 18.69-11.85.25 1.5.38 2.75.38 3.75 0 6.84-2.5 13.38-7.5 19.62-5 6.24-11.21 10.24-18.63 12-.12-1.12-.29-2.56-.29-4.32z" />
    </svg>
  );
}

// The four squares are at (1,1) (12,1) (1,12) (12,12). The reference markup this
// was ported from used H1 on three of them, which collapsed them into slivers.
function MicrosoftIcon() {
  return (
    <svg data-brand-logo className="h-4 w-4" viewBox="0 0 23 23">
      <path d="M1 1h10v10H1z" fill="#f35325" />
      <path d="M12 1h10v10H12z" fill="#81bc06" />
      <path d="M1 12h10v10H1z" fill="#05a6f0" />
      <path d="M12 12h10v10H12z" fill="#ffba08" />
    </svg>
  );
}

/**
 * Only Google is wired, because Google is the only OAuth provider that exists in
 * packages/backend/convex/auth.ts. Apple and Microsoft are rendered but disabled:
 * calling signIn("apple") against a provider that was never registered throws,
 * and a button that throws is worse than a button that says "not yet".
 */
export function OAuthRow({
  onGoogle,
  disabled,
}: {
  onGoogle: () => void;
  disabled: boolean;
}) {
  // Three equal-width columns. The "Or Continue With" header + top border that
  // used to live here were removed — auth-panel now owns the OR divider, so
  // keeping them too would render two dividers.
  return (
    <div className="grid grid-cols-3 gap-3">
      <button type="button" onClick={onGoogle} disabled={disabled} className={BUTTON}>
        <GoogleIcon />
        <span>Google</span>
      </button>

      <button
        type="button"
        disabled
        title="Apple sign-in is not configured yet"
        className={BUTTON}
      >
        <AppleIcon />
        <span>Apple</span>
      </button>

      <button
        type="button"
        disabled
        title="Microsoft sign-in is not configured yet"
        className={BUTTON}
      >
        <MicrosoftIcon />
        <span>Microsoft</span>
      </button>
    </div>
  );
}
