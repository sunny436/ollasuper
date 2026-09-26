import { expect, test } from "bun:test";
import { type WaitingUpload, releaseWaiting } from "./use-attachments";

const held = (localId: string): WaitingUpload => ({
  localId,
  file: new File(["x"], `${localId}.txt`, { type: "text/plain" }),
});

test("files attached before the workspace resolves are held, then all started in order", () => {
  // The first second after page load: the workspace is still null. These used
  // to be dropped outright — no chip, no upload mutation.
  const waiting = [held("a1"), held("a2"), held("a3")];
  const started = releaseWaiting(waiting, new Set());
  expect(started.map((w) => w.localId)).toEqual(["a1", "a2", "a3"]);
  expect(started[0]?.file.name).toBe("a1.txt");
  expect(waiting).toHaveLength(0);
});

test("a chip removed while waiting is never uploaded, and its cancellation is consumed", () => {
  const waiting = [held("a1"), held("a2")];
  const cancelled = new Set(["a2", "a9"]);
  expect(releaseWaiting(waiting, cancelled).map((w) => w.localId)).toEqual(["a1"]);
  // a2 had no upload to undo; a9 belongs to an in-flight upload and must stay.
  expect([...cancelled]).toEqual(["a9"]);
});

test("releasing twice starts nothing twice", () => {
  const waiting = [held("a1")];
  expect(releaseWaiting(waiting, new Set())).toHaveLength(1);
  expect(releaseWaiting(waiting, new Set())).toHaveLength(0);
});
