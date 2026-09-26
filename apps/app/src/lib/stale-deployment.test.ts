import { expect, test } from "bun:test";
import { isStaleDeploymentError } from "./stale-deployment";

test("Next's unknown-Server-Action error is recognised by name", () => {
  const e = new Error("anything");
  e.name = "UnrecognizedActionError";
  expect(isStaleDeploymentError(e)).toBe(true);
});

test("…and by its message, should the name ever be lost", () => {
  const e = new Error(
    'Server Action "00cae047400d2c08656278b8207fb1a22b85827dbc" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
  );
  expect(isStaleDeploymentError(e)).toBe(true);
});

test("a real sign-in failure is NOT mistaken for one", () => {
  expect(isStaleDeploymentError(new Error("Invalid email or password."))).toBe(false);
  expect(isStaleDeploymentError({ data: "Invalid email or password." })).toBe(false);
  expect(isStaleDeploymentError(undefined)).toBe(false);
});
