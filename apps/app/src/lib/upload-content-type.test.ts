import { describe, expect, test } from "bun:test";
import { storageContentType } from "./upload-content-type";

describe("storageContentType", () => {
  test("neuters what a browser would execute", () => {
    for (const t of [
      "text/html",
      "TEXT/HTML",
      "text/html; charset=utf-8",
      "image/svg+xml",
      "application/xhtml+xml",
      "text/xsl",
    ]) {
      expect(storageContentType(t)).toBe("text/plain");
    }
  });

  test("leaves ordinary types exactly as they are", () => {
    for (const t of ["image/png", "application/pdf", "text/csv", "text/plain"]) {
      expect(storageContentType(t)).toBe(t);
    }
  });

  test("an empty browser MIME still uploads (code files have none)", () => {
    // Convex storage 400s on a missing content-type, so this fallback is
    // load-bearing for .py/.ts/.go uploads.
    expect(storageContentType("")).toBe("application/octet-stream");
  });
});
