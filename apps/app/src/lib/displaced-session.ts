/**
 * Hand-off between the dashboard shell (which learns the session was revoked)
 * and the login page (which has to explain why the user is suddenly here).
 *
 * sessionStorage rather than a query param: the redirect is driven by middleware
 * after signOut, so there is no URL under our control to decorate, and a param
 * would survive being shared or bookmarked. Nothing sensitive is stored — just a
 * flag saying "show the displaced message once".
 */
export const DISPLACED_KEY = "myos.session.displaced";

/**
 * A sign-out the user asked for (Log out, account deletion).
 *
 * The server deletes the session a moment before the browser drops its token,
 * so for that moment `authSessions.sessionState` reads "ended" — exactly what a
 * session revoked from elsewhere looks like. Without this mark an ordinary Log
 * out would be greeted with "used on another device". Time-bound, not a latch:
 * a later sign-in in the same page must be told if it is displaced.
 */
const INTENTIONAL_WINDOW_MS = 30_000;
let intentionalAt = 0;

export function markIntentionalSignOut(): void {
  intentionalAt = Date.now();
}

export function isIntentionalSignOut(now = Date.now()): boolean {
  return now - intentionalAt < INTENTIONAL_WINDOW_MS;
}

/** Reads and clears the flag, so the message shows exactly once. */
export function consumeDisplacedFlag(): boolean {
  try {
    if (window.sessionStorage.getItem(DISPLACED_KEY) !== "1") return false;
    window.sessionStorage.removeItem(DISPLACED_KEY);
    return true;
  } catch {
    return false;
  }
}
