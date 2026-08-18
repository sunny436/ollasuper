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
