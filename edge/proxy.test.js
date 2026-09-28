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

// ---------------------------------------------------------------- upload tickets
// File Library disk safety: every upload is redeemed against Convex (a single-
// use ticket bound to one user and a byte count) before a byte is forwarded.
const {
  CONFIG,
  handleUpload,
  isPrivateSitePath,
  takeTicket,
} = require("./proxy.js");

const TICKET = "a".repeat(43);

async function ticketHarness({ maxBytes = 100, redeemStatus = 200 } = {}) {
  const seen = { redeems: [], upstream: 0, upstreamPath: "", bytes: 0, completed: 0 };
  const site = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.redeems.push({ path: req.url, key: req.headers["x-edge-key"], body: JSON.parse(body) });
      res.writeHead(redeemStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(redeemStatus === 200 ? { ok: true, maxBytes } : { ok: false }));
    });
  });
  const upstream = http.createServer((req, res) => {
    seen.upstream += 1;
    seen.upstreamPath = req.url;
    req.on("data", (c) => {
      seen.bytes += c.length;
    });
    req.on("end", () => {
      seen.completed += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ storageId: "kg_ok" }));
    });
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const saved = { ...CONFIG };
  CONFIG.sitePort = site.address().port;
  CONFIG.ticketSecret = "edge-test-secret";
  CONFIG.minFreeBytes = 1;
  const upPort = upstream.address().port;
  const proxy = http.createServer((req, res) =>
    handleUpload(req, res, {
      port: upPort,
      path: req.url,
      storage: true,
      upload: true,
    }),
  );
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const close = async () => {
    Object.assign(CONFIG, saved);
    await Promise.all([
      new Promise((r) => proxy.close(r)),
      new Promise((r) => upstream.close(r)),
      new Promise((r) => site.close(r)),
    ]);
  };
  return { seen, port: proxy.address().port, close };
}

function postTo(port, path, chunks, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", () => resolve({ status: "reset" }));
    let i = 0;
    const next = () => {
      if (i >= chunks.length) return req.end();
      req.write(chunks[i++], () => setImmediate(next));
    };
    next();
  });
}

test("an upload with no ticket is refused and Convex never sees it", async () => {
  const h = await ticketHarness();
  try {
    const res = await postTo(h.port, "/api/storage/upload?token=t", [Buffer.alloc(10)], {
      "content-length": "10",
    });
    assert.equal(res.status, 403);
    assert.equal(h.seen.redeems.length, 0);
    assert.equal(h.seen.upstream, 0);
  } finally {
    await h.close();
  }
});

test("a ticket Convex refuses (used, expired, unknown) is refused", async () => {
  const h = await ticketHarness({ redeemStatus: 403 });
  try {
    const res = await postTo(h.port, `/api/storage/upload?token=t&lt=${TICKET}`, [Buffer.alloc(10)], {
      "content-length": "10",
    });
    assert.equal(res.status, 403);
    assert.equal(h.seen.redeems.length, 1);
    assert.equal(h.seen.redeems[0].key, "edge-test-secret");
    assert.deepEqual(h.seen.redeems[0].body, { ticket: TICKET });
    assert.equal(h.seen.upstream, 0);
  } finally {
    await h.close();
  }
});

test("a valid ticket forwards the body WITHOUT the ticket, up to its size", async () => {
  const h = await ticketHarness({ maxBytes: 100 });
  try {
    const ok = await postTo(h.port, `/api/storage/upload?token=abc%2Bdef&lt=${TICKET}`, [Buffer.alloc(60, 1)], {
      "content-length": "60",
    });
    assert.equal(ok.status, 200);
    assert.equal(h.seen.upstreamPath, "/api/storage/upload?token=abc%2Bdef");
    assert.equal(h.seen.bytes, 60);
  } finally {
    await h.close();
  }
});

test("a body longer than the ticket admits is cut off (declared or streamed)", async () => {
  const declared = await ticketHarness({ maxBytes: 100 });
  try {
    const res = await postTo(declared.port, `/api/storage/upload?lt=${TICKET}`, [Buffer.alloc(200)], {
      "content-length": "200",
    });
    assert.equal(res.status, 413);
    assert.equal(declared.seen.completed, 0);
  } finally {
    await declared.close();
  }
  const streamed = await ticketHarness({ maxBytes: 100 });
  try {
    const chunks = Array.from({ length: 8 }, () => Buffer.alloc(64, 2));
    const res = await postTo(streamed.port, `/api/storage/upload?lt=${TICKET}`, chunks, {
      "transfer-encoding": "chunked",
    });
    assert.ok(res.status === 413 || res.status === "reset", String(res.status));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(streamed.seen.completed, 0, "the upstream received a complete body");
    assert.ok(streamed.seen.bytes <= 100, `upstream got ${streamed.seen.bytes} bytes`);
  } finally {
    await streamed.close();
  }
});

test("below the free-disk floor every upload is refused (507) before redeeming anything", async () => {
  const h = await ticketHarness();
  CONFIG.minFreeBytes = Number.MAX_SAFE_INTEGER;
  try {
    const res = await postTo(h.port, `/api/storage/upload?lt=${TICKET}`, [Buffer.alloc(10)], {
      "content-length": "10",
    });
    assert.equal(res.status, 507);
    assert.equal(h.seen.redeems.length, 0, "a ticket must not be burned on a refusal");
    assert.equal(h.seen.upstream, 0);
  } finally {
    await h.close();
  }
});

test("without the shared secret the gate fails CLOSED", async () => {
  const h = await ticketHarness();
  CONFIG.ticketSecret = "";
  try {
    const res = await postTo(h.port, `/api/storage/upload?lt=${TICKET}`, [Buffer.alloc(10)], {
      "content-length": "10",
    });
    assert.equal(res.status, 503);
    assert.equal(h.seen.upstream, 0);
  } finally {
    await h.close();
  }
});

test("host-only Convex site paths are never reachable from outside", () => {
  for (const url of [
    "/__cvx-site/edge/upload-ticket",
    "/__cvx-site/ops/library-health",
    "/__cvx-site/edge",
  ]) {
    const r = route("app.ollasuper.com", url);
    assert.equal(isPrivateSitePath(r.port, r.path), true, url);
  }
  const host = route("convex-site.ollasuper.com", "/ops/library-health");
  assert.equal(isPrivateSitePath(host.port, host.path), true);
  for (const url of ["/__cvx-site/library/file?t=x", "/__cvx-site/ai/ingress", "/edge/upload-ticket"]) {
    const r = route("app.ollasuper.com", url);
    assert.equal(isPrivateSitePath(r.port, r.path), false, url);
  }
});

test("the ticket is removed from the query string and nothing else is touched", () => {
  assert.deepEqual(takeTicket(`/api/storage/upload?token=a%2Fb%3D&lt=${TICKET}`), {
    ticket: TICKET,
    path: "/api/storage/upload?token=a%2Fb%3D",
  });
  assert.deepEqual(takeTicket(`/api/storage/upload?lt=${TICKET}&token=x`), {
    ticket: TICKET,
    path: "/api/storage/upload?token=x",
  });
  assert.deepEqual(takeTicket("/api/storage/upload?token=x"), {
    ticket: "",
    path: "/api/storage/upload?token=x",
  });
});
