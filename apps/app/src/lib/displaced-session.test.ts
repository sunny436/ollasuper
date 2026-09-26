import { expect, test } from "bun:test";
import { isIntentionalSignOut, markIntentionalSignOut } from "./displaced-session";

test("a deliberate sign-out is recognised for a short window, then forgotten", () => {
  const before = Date.now();
  expect(isIntentionalSignOut(before)).toBe(false);
  markIntentionalSignOut();
  expect(isIntentionalSignOut()).toBe(true);
  // A later sign-in in the same page must still be told if it is displaced.
  expect(isIntentionalSignOut(Date.now() + 31_000)).toBe(false);
});
