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
  test("follows the measured refresh interval", () => {
    expect(frameBudget(16.7)).toBeCloseTo(16.7, 1);
    expect(frameBudget(8.3)).toBeCloseTo(8.3, 1);
    expect(frameBudget(6.9)).toBeCloseTo(6.9, 1); // 144 Hz desktop
    expect(frameBudget(1)).toBe(4);
    expect(frameBudget(80)).toBe(34);
    expect(frameBudget(Number.POSITIVE_INFINITY)).toBeCloseTo(16.67, 1);
  });
  test("dropped means at least one missed frame", () => {
    expect(isDropped(17, 16.7)).toBe(false);
    expect(isDropped(34, 16.7)).toBe(true);
    expect(isDropped(13.9, 6.9)).toBe(true); // every other 144 Hz vsync
    expect(isDropped(8.4, 8.3)).toBe(false);
  });
});

test("scrubPath removes conversation ids", () => {
  expect(scrubPath("/en/chat/m17dbgkjk6t4cmhhjwbn5zn7bs8ejjfp")).toBe("/en/chat/:id");
  expect(scrubPath("/en/settings")).toBe("/en/settings");
});
