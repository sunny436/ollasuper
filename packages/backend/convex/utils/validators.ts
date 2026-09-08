import { z } from "zod";

/**
 * Username.
 *
 * ORDER IS LOAD-BEARING. This used to read
 * `.min(3).max(32).toLowerCase().trim()`, and zod applies string checks in the
 * order they are declared — so `min` ran against the RAW input and `trim`
 * happened afterwards. Measured: `"  a  "` passed and stored `"a"`, and
 * `"  ab  "` stored `"ab"`, both under the 3-character minimum the UI promises.
 * Normalising FIRST and validating the normalised value closes that.
 *
 * Lowercase is the storage form, which also makes collisions inherently
 * case-insensitive: `Admin`, `ADMIN` and `admin` are one identity, so an
 * impersonation variant cannot coexist with the real name.
 */
export const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Username must be at least 3 characters.")
  .max(32, "Username must be 32 characters or fewer.")
  .regex(/^[a-z0-9]+$/, "Username may only contain letters and numbers.");
