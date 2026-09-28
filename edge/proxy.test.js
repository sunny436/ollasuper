// Run: node --test edge/proxy.test.js   (no dependencies; requiring proxy.js
// does not start the server — it only listens when executed directly).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  route,
  isStorageResponse,
  storageHeaders,
  isUploadRequest,
  forward,
  MAX_UPLOAD_BYTES,
} = require("./proxy.js");

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

// ---------------------------------------------------------------- P0-10
test("only Convex storage uploads are capped, on both routing modes", () => {
  for (const url of ["/__cvx/api/storage/upload?token=abc", "/__cvx-site/api/storage/upload"]) {
    const r = route("app.ollasuper.com", url);
    assert.equal(isUploadRequest(r.port, r.path), true, url);
  }
  const host = route("convex.ollasuper.com", "/api/storage/upload?token=abc");
  assert.equal(isUploadRequest(host.port, host.path), true);
  for (const url of ["/__cvx/api/mutation", "/__cvx/api/storage/abc", "/api/storage/upload"]) {
    const r = route("app.ollasuper.com", url);
    assert.equal(isUploadRequest(r.port, r.path), false, url);
  }
  assert.equal(MAX_UPLOAD_BYTES, 26 * 1024 * 1024);
});

// A real upstream + a real proxy hop, with a small cap so the test is fast.
async function harness(max) {
  const seen = { requests: 0, completed: 0, bytes: 0 };
  const upstream = http.createServer((req, res) => {
    seen.requests += 1;
    req.on("data", (c) => {
      seen.bytes += c.length;
    });
    req.on("end", () => {
      seen.completed += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ storageId: "kg_test" }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;
  const proxy = http.createServer((req, res) =>
    forward(req, res, {
      port: upPort,
      path: "/api/storage/upload?token=t",
      storage: true,
      upload: true,
      maxUpload: max,
    }),
  );
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const close = () =>
    Promise.all([
      new Promise((r) => proxy.close(r)),
      new Promise((r) => upstream.close(r)),
    ]);
  return { seen, port: proxy.address().port, close };
}

function post(port, chunks, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "POST", headers },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    // The proxy may close the socket after its 413; that is the point.
    req.on("error", () => resolve({ status: "reset" }));
    let i = 0;
    const next = () => {
      if (i >= chunks.length) return req.end();
      req.write(chunks[i++], () => setImmediate(next));
    };
    next();
  });
}

test("a declared oversize upload is refused before Convex sees a byte", async () => {
  const h = await harness(1024);
  try {
    const res = await post(h.port, [Buffer.alloc(2048)], { "content-length": "2048" });
    assert.equal(res.status, 413);
    assert.equal(h.seen.requests, 0);
  } finally {
    await h.close();
  }
});

test("a chunked upload with no length is cut off at the cap and never completes upstream", async () => {
  const h = await harness(1024);
  try {
    const chunks = Array.from({ length: 16 }, () => Buffer.alloc(256, 1));
    const res = await post(h.port, chunks, { "transfer-encoding": "chunked" });
    assert.ok(res.status === 413 || res.status === "reset", String(res.status));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.seen.completed, 0, "the upstream received a complete body");
    assert.ok(h.seen.bytes <= 1024, `upstream got ${h.seen.bytes} bytes`);
  } finally {
    await h.close();
  }
});

test("an upload under the cap is forwarded byte-for-byte", async () => {
  const h = await harness(4096);
  try {
    const res = await post(h.port, [Buffer.alloc(1000, 3), Buffer.alloc(1000, 4)], {
      "content-length": "2000",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { storageId: "kg_test" });
    assert.equal(h.seen.bytes, 2000);
    assert.equal(h.seen.completed, 1);
  } finally {
    await h.close();
  }
});
