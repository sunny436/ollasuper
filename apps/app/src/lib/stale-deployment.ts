/**
 * Is this error the running page being older than the server?
 *
 * Every sign-in ends with @convex-dev/auth awaiting its `invalidateCache` Server
 * Action. A tab opened before a deploy still holds the previous build's action
 * id, so Next answers "not found" and throws `UnrecognizedActionError` — AFTER
 * the server has already signed the user in and set the auth cookies. The sign-in
 * form used to report that as "Invalid email or password" (seen on production;
 * the server logged "Failed to find Server Action"). The right answer is a full
 * page load: the cookies are there, and the new document brings the new bundle.
 *
 * Matched on `name` (a string literal Next sets in the constructor, so it
 * survives minification) with the message as a fallback.
 */
export function isStaleDeploymentError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "UnrecognizedActionError" ||
    /Server Action "[^"]*" was not found on the server/.test(err.message)
  );
}
