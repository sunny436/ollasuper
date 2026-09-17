import { expect, test } from "bun:test";
import { highlight } from "./highlighter";

// No grammar is preloaded any more: every language must still load on first use,
// aliases must still resolve, and an unknown language must fall back (null ->
// plain <pre>) without throwing.
test("grammars load on demand, aliases resolve, unknown falls back", async () => {
  expect(await highlight("const x: number = 1;", "ts")).not.toBeNull();
  expect(await highlight("def f(x):\n    return x", "python")).not.toBeNull();
  expect(await highlight("SELECT 1;", "postgres")).not.toBeNull();
  expect(await highlight("x", "definitely-not-a-language")).toBeNull();
  expect(await highlight("", "ts")).toBeNull();
}, 60000);
