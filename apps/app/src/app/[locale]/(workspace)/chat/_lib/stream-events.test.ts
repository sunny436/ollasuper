import { describe, expect, test } from "bun:test";
import type { TypedEvent } from "./agent-events";
import { accumulateEvents, afterSeqFor } from "./stream-events";

const ev = (seq: number, id = `e${seq}`): TypedEvent => ({
  eventId: id,
  seq,
  type: "TOOL_CALL",
  v: 1,
  ts: 1000 + seq,
  payload: "{}",
});

describe("afterSeqFor", () => {
  test("asks for everything when there is nothing yet", () => {
    expect(afterSeqFor(null, "m1")).toBeUndefined();
  });

  test("asks for everything for a DIFFERENT message", () => {
    const acc = accumulateEvents(null, "m1", [ev(0), ev(1)]);
    expect(afterSeqFor(acc, "m2")).toBeUndefined();
  });

  test("asks for everything with no messageId", () => {
    expect(afterSeqFor(null, null)).toBeUndefined();
  });

  test("asks above the high-water mark once it has one", () => {
    const acc = accumulateEvents(null, "m1", [ev(0), ev(1), ev(2)]);
    expect(afterSeqFor(acc, "m1")).toBe(2);
  });
});

describe("accumulateEvents", () => {
  test("no messageId accumulates nothing", () => {
    expect(accumulateEvents(null, null, [ev(0)])).toBeNull();
  });

  test("an empty result still establishes the message", () => {
    const acc = accumulateEvents(null, "m1", []);
    expect(acc).toEqual({ messageId: "m1", maxSeq: -1, events: [] });
  });

  test("appends only what is new and advances the mark", () => {
    let acc = accumulateEvents(null, "m1", [ev(0), ev(1)]);
    acc = accumulateEvents(acc, "m1", [ev(2)]);
    expect(acc?.maxSeq).toBe(2);
    expect(acc?.events.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  test("the same event twice is kept once — subscriptions overlap on a swap", () => {
    let acc = accumulateEvents(null, "m1", [ev(0), ev(1)]);
    acc = accumulateEvents(acc, "m1", [ev(1), ev(2)]);
    expect(acc?.events.map((e) => e.eventId)).toEqual(["e0", "e1", "e2"]);
  });

  test("an unchanged result returns the SAME object, so React can skip", () => {
    const acc = accumulateEvents(null, "m1", [ev(0)]);
    expect(accumulateEvents(acc, "m1", [])).toBe(acc);
    expect(accumulateEvents(acc, "m1", [ev(0)])).toBe(acc);
    expect(accumulateEvents(acc, "m1", null)).toBe(acc);
  });

  test("a new message starts clean rather than inheriting the last reply", () => {
    const first = accumulateEvents(null, "m1", [ev(0), ev(1)]);
    const second = accumulateEvents(first, "m2", [ev(0)]);
    expect(second?.messageId).toBe("m2");
    expect(second?.events).toHaveLength(1);
    expect(second?.maxSeq).toBe(0);
  });

  test("out-of-order arrivals are sorted — the timeline reads this in order", () => {
    let acc = accumulateEvents(null, "m1", [ev(2)]);
    acc = accumulateEvents(acc, "m1", [ev(0), ev(1)]);
    expect(acc?.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(acc?.maxSeq).toBe(2);
  });

  test("the mark never goes backwards on a late low-seq arrival", () => {
    let acc = accumulateEvents(null, "m1", [ev(5)]);
    acc = accumulateEvents(acc, "m1", [ev(1, "late")]);
    expect(acc?.maxSeq).toBe(5);
  });

  test("the full timeline is what a consumer sees — the whole point", () => {
    let acc: ReturnType<typeof accumulateEvents> = null;
    for (let i = 0; i < 16; i++) acc = accumulateEvents(acc, "m1", [ev(i)]);
    expect(acc?.events).toHaveLength(16);
    expect(acc?.events.map((e) => e.seq)).toEqual([...Array(16).keys()]);
  });
});
