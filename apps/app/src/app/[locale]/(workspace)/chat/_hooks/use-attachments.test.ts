import { expect, test } from "bun:test";
import {
  type WaitingUpload,
  chipsFor,
  releaseWaiting,
  threadKeyOf,
  withoutChips,
} from "./use-attachments";

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

// A chip added in one conversation used to follow the user into "New chat" and
// every other chat (the composer outlives navigation), and was sent there.
const chip = (localId: string, threadKey: string) => ({ localId, threadKey });

test("each conversation sees only its own unsent chips", () => {
  const all = [chip("a1", "thread_A"), chip("a2", "new"), chip("a3", "thread_A")];
  expect(chipsFor(all, "thread_A").map((c) => c.localId)).toEqual(["a1", "a3"]);
  expect(chipsFor(all, threadKeyOf(null)).map((c) => c.localId)).toEqual(["a2"]);
  expect(chipsFor(all, "thread_B")).toEqual([]);
});

test("sent chips are cleared by id even after the conversation switched mid-send", () => {
  // First send from the landing screen: chips keyed "new", and by the time the
  // send resolves the composer is already on the freshly created thread.
  const all = [chip("a1", "new"), chip("a2", "new"), chip("a9", "thread_A")];
  const left = withoutChips(all, ["a1", "a2"]);
  expect(left.map((c) => c.localId)).toEqual(["a9"]);
  // Nothing is left behind to reappear on the next New chat.
  expect(chipsFor(left, "new")).toEqual([]);
});
