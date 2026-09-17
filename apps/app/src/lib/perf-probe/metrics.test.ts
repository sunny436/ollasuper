import { describe, expect, test } from "bun:test";
import { frameBudget, isDropped, scrubPath, summarize } from "./metrics";

describe("summarize", () => {
  test("empty is null", () => {
    expect(summarize([])).toBeNull();
  });
  test("nearest-rank percentiles", () => {
    const s = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(s).toEqual({ n: 10, p50: 50, p90: 90, max: 100 });
  });
  test("single sample", () => {
    expect(summarize([7.4])).toEqual({ n: 1, p50: 7, p90: 7, max: 7 });
  });
  test("does not mutate its input", () => {
    const xs = [3, 1, 2];
    summarize(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("frame budget", () => {
  test("60 Hz and 120 Hz", () => {
    expect(frameBudget(16.6)).toBeCloseTo(16.67, 1);
    expect(frameBudget(8.3)).toBeCloseTo(8.33, 1);
    expect(frameBudget(Number.POSITIVE_INFINITY)).toBeCloseTo(16.67, 1);
  });
  test("dropped means at least one missed frame", () => {
    expect(isDropped(17, 1000 / 60)).toBe(false);
    expect(isDropped(34, 1000 / 60)).toBe(true);
    expect(isDropped(17, 1000 / 120)).toBe(true);
  });
});

test("scrubPath removes conversation ids", () => {
  expect(scrubPath("/en/chat/m17dbgkjk6t4cmhhjwbn5zn7bs8ejjfp")).toBe("/en/chat/:id");
  expect(scrubPath("/en/settings")).toBe("/en/settings");
});
