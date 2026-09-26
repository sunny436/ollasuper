// Run: node --test edge/proxy.test.js   (no dependencies; requiring proxy.js
// does not start the server — it only listens when executed directly).
const test = require("node:test");
const assert = require("node:assert/strict");
const { route, isStorageResponse, storageHeaders } = require("./proxy.js");

test("raw storage is recognised on both routing modes and both ports (audit F-02)", () => {
  for (const url of ["/__cvx/api/storage/abc", "/__cvx-site/api/storage/abc"]) {
    const r = route("app.ollasuper.com", url);
    assert.equal(isStorageResponse(r.port, r.path), true, url);
  }
  const host = route("convex.ollasuper.com", "/api/storage/abc");
  assert.equal(isStorageResponse(host.port, host.path), true);
  // The Next app's own responses are never rewritten.
  const app = route("app.ollasuper.com", "/api/storage/abc");
  assert.equal(isStorageResponse(app.port, app.path), false);
  const cvx = route("app.ollasuper.com", "/__cvx/api/query");
  assert.equal(isStorageResponse(cvx.port, cvx.path), false);
});

test("an XML/HTML/SVG blob can never render as an active document on the app origin", () => {
  for (const type of [
    "text/xml; charset=utf-8",
    "application/xml",
    "text/html",
    "image/svg+xml",
    "application/xslt+xml",
    "application/octet-stream",
    "",
  ]) {
    const h = storageHeaders({ "content-type": type });
    assert.equal(h["content-disposition"], "attachment", type);
    assert.equal(h["content-security-policy"], "sandbox", type);
    assert.equal(h["x-content-type-options"], "nosniff", type);
  }
});

test("inline-safe types still display inline", () => {
  const png = storageHeaders({ "content-type": "image/png" });
  assert.equal(png["content-disposition"], undefined);
  assert.equal(png["content-security-policy"], "sandbox");
  const pdf = storageHeaders({ "content-type": "application/pdf" });
  assert.equal(pdf["content-disposition"], undefined);
  // Chromium's PDF viewer refuses to render inside a sandbox.
  assert.equal(pdf["content-security-policy"], undefined);
  assert.equal(pdf["x-content-type-options"], "nosniff");
});

test("existing upstream headers are preserved, not dropped", () => {
  const h = storageHeaders({ "content-type": "image/png", etag: '"x"', "content-length": "3" });
  assert.equal(h.etag, '"x"');
  assert.equal(h["content-length"], "3");
});
