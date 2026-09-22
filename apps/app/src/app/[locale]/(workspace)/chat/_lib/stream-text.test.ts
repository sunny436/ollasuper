import { describe, expect, test } from "bun:test";
import { type Accumulated, accumulate, needsCommitted } from "./stream-text";

const live = (
  chunks: [number, string][],
  committedSeq = -1,
  messageId = "m1",
) => ({
  messageId,
  committedSeq,
  chunks: chunks.map(([seq, text]) => ({ seq, text })),
});

describe("stream-text accumulate", () => {
  test("steady state: appends only unseen chunks, keeps identity when nothing is new", () => {
    let acc: Accumulated | null = null;
    acc = accumulate(acc, live([[0, "Hel"]]), null);
    expect(acc).toEqual({ messageId: "m1", upToSeq: 0, text: "Hel" });
    acc = accumulate(acc, live([[0, "Hel"], [1, "lo"]]), null);
    expect(acc?.text).toBe("Hello");
    const same = accumulate(acc, live([[0, "Hel"], [1, "lo"]]), null);
    expect(same).toBe(acc); // identity preserved → no re-render
    expect(needsCommitted(acc, live([[1, "lo"]], 0))).toBe(false);
  });

  test("compaction with the chunks already seen needs no committed prefix", () => {
    let acc: Accumulated | null = null;
    acc = accumulate(acc, live([[0, "a"], [1, "b"], [2, "c"]]), null);
    // server compacted 0..2 and now only carries 3
    const after = live([[3, "d"]], 2);
    expect(needsCommitted(acc, after)).toBe(false);
    acc = accumulate(acc, after, null);
    expect(acc?.text).toBe("abcd");
    expect(acc?.upToSeq).toBe(3);
  });

  test("mid-stream mount: a gap is filled once from the committed prefix, then closed", () => {
    const first = live([[24, "X"], [25, "Y"]], 23);
    expect(needsCommitted(null, first)).toBe(true);
    // without the prefix, resident chunks must NOT be appended (they come after the hole)
    let acc = accumulate(null, first, null);
    expect(acc).toEqual({ messageId: "m1", upToSeq: -1, text: "" });
    expect(needsCommitted(acc, first)).toBe(true);
    acc = accumulate(acc, first, {
      messageId: "m1",
      committedSeq: 23,
      committedText: "prefix ",
    });
    expect(acc?.text).toBe("prefix XY");
    expect(acc?.upToSeq).toBe(25);
    expect(needsCommitted(acc, first)).toBe(false);
  });

  test("a committed prefix newer than the tail push skips the chunks it already contains", () => {
    const tail = live([[22, "u"], [23, "v"], [24, "w"]], 21);
    const acc = accumulate(null, tail, {
      messageId: "m1",
      committedSeq: 23, // compaction ran between the two subscriptions
      committedText: "…uv",
    });
    expect(acc?.text).toBe("…uvw");
    expect(acc?.upToSeq).toBe(24);
  });

  test("a stale prefix (behind the tail's committedSeq) does not close the gap", () => {
    const tail = live([[30, "z"]], 29);
    const acc = accumulate(null, tail, { messageId: "m1", committedSeq: 23, committedText: "old" });
    expect(acc?.text).toBe("");
    expect(needsCommitted(acc, tail)).toBe(true);
  });

  test("a new message resets the accumulator; null live clears it", () => {
    let acc = accumulate(null, live([[0, "one"]]), null);
    acc = accumulate(acc, live([[0, "two"]], -1, "m2"), null);
    expect(acc).toEqual({ messageId: "m2", upToSeq: 0, text: "two" });
    expect(accumulate(acc, null, null)).toBeNull();
  });

  test("holes in seq (a dropped batch) are tolerated: append what is resident, above what we hold", () => {
    let acc = accumulate(null, live([[0, "a"]]), null);
    acc = accumulate(acc, live([[0, "a"], [2, "c"]]), null); // seq 1 was evicted upstream
    expect(acc?.text).toBe("ac");
    expect(acc?.upToSeq).toBe(2);
  });
});
