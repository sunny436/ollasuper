// Edge adapter on 127.0.0.1:5150.
//
// WHY THIS EXISTS: the Cloudflare tunnel is token/dashboard-managed. Its ingress
// cannot be edited from this VM, nor with the zone-scoped API token we hold
// (verified: account reads return 9109, tunnel config returns 1001). The tunnel's
// existing rule already forwards app.ollasuper.com -> localhost:5150, so we
// terminate there and route onward ourselves.
//
// Two routing modes, in priority order:
//
//   1. PATH  — /__cvx/*  -> :3210   and  /__cvx-site/*  -> :3211
//      Works with NO Cloudflare changes at all, because it rides the one
//      hostname the tunnel already serves. Prefix is stripped before proxying.
//      The "__" prefix is deliberate: it cannot collide with a Next.js route.
//
//   2. HOST  — app/convex/convex-site .ollasuper.com -> :3000/:3210/:3211
//      The clean form. Only reachable once those two hostnames are added as
//      Public Hostnames on the tunnel in the Zero Trust dashboard.
//
// Both are live simultaneously, so adding the dashboard entries later needs no
// change here — and this whole file can then be deleted.
//
// The 'upgrade' handler is load-bearing: the Convex browser client is a WSS
// connection, so a proxy handling only 'request' would serve pages fine and
// silently break every chat stream.
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const { Transform } = require("node:stream");

// Ports and the upload gate are configurable (EnvironmentFile=/etc/myos/edge.env
// in production; a staging copy runs on other ports). Defaults = production.
const CONFIG = {
  port: Number(process.env.EDGE_PORT) || 5150,
  appPort: Number(process.env.EDGE_APP_PORT) || 3000,
  cvxPort: Number(process.env.EDGE_CVX_PORT) || 3210,
  sitePort: Number(process.env.EDGE_SITE_PORT) || 3211,
  // Shared with Convex (EDGE_TICKET_SECRET) to redeem upload tickets. Unset =
  // every upload refused (fail closed), never an unmetered upload.
  ticketSecret: process.env.EDGE_TICKET_SECRET || "",
  // Below this much free disk, uploads are refused (507) before a byte lands.
  minFreeBytes: Number(process.env.EDGE_MIN_FREE_BYTES) || 4 * 1024 * 1024 * 1024,
  diskPath: process.env.EDGE_DISK_PATH || "/",
};

const HOST_ROUTES = {
  "app.ollasuper.com": CONFIG.appPort,
  "convex.ollasuper.com": CONFIG.cvxPort,
  "convex-site.ollasuper.com": CONFIG.sitePort,
};
const PATH_ROUTES = [
  { prefix: "/__cvx-site", port: CONFIG.sitePort },
  { prefix: "/__cvx", port: CONFIG.cvxPort },
];
const DEFAULT = CONFIG.appPort;

// Returns { port, path }. Path routing wins so it works on the app hostname.
function route(hostHeader, url) {
  for (const r of PATH_ROUTES) {
    if (url === r.prefix || url.startsWith(r.prefix + "/") || url.startsWith(r.prefix + "?")) {
      const rest = url.slice(r.prefix.length) || "/";
      return { port: r.port, path: rest.startsWith("/") ? rest : "/" + rest };
    }
  }
  const host = String(hostHeader || "").split(":")[0].toLowerCase();
  return { port: HOST_ROUTES[host] ?? DEFAULT, path: url };
}

// CVE-2025-29927 (GHSA-f82v-jwr5-mffw): Next.js skips middleware entirely when it
// sees `x-middleware-subrequest`. On this app that would bypass the auth redirect,
// the i18n rewrite, and BOTH per-IP throttles in apps/app/src/middleware.ts.
//
// It is an INTERNAL header — Next sets it on its own subrequests — so nothing
// legitimate ever arrives carrying it from outside, and dropping it at the only
// door into the stack is exact rather than heuristic.
//
// THIS IS A MITIGATION, NOT THE FIX. The fix is Next >= 15.5.16, which also
// closes the flight-protocol RCE this cannot touch. It stays useful afterwards
// as defence in depth.
function safeHeaders(headers) {
  const { "x-middleware-subrequest": _dropped, ...rest } = headers;
  return rest;
}

// RAW STORAGE IS SERVED FROM THE APP'S OWN ORIGIN (audit F-02).
//
// ctx.storage.getUrl() mints /api/storage/<id> URLs that reach the browser
// through /__cvx on app.ollasuper.com, and Convex serves each blob with the
// content-type its UPLOAD declared. An XML document with an xml-stylesheet
// (or HTML/SVG) opened from such a URL therefore ran script as the app.
// Registration-time type checks cannot cover a blob that was never registered,
// or one stored before a type was added to the list — and next.config.mjs's
// headers never touch these responses, because they are not Next responses.
// So the rule is enforced HERE, on the response itself:
//
//   * nosniff, always;
//   * `Content-Security-Policy: sandbox` (no allow-scripts) — the document gets
//     an opaque origin and runs no script — except for PDF, which Chromium's
//     viewer refuses to render inside a sandbox, and which is not an
//     app-origin script vector;
//   * `Content-Disposition: attachment` for everything not on an explicit
//     INLINE allowlist — an allowlist fails closed on the type nobody thought of.
const STORAGE_UPSTREAM_PORTS = new Set([CONFIG.cvxPort, CONFIG.sitePort]);
const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "application/pdf",
  "text/plain",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
]);

function isStorageResponse(port, path) {
  return STORAGE_UPSTREAM_PORTS.has(port) && /^\/api\/storage\//.test(path);
}

function storageHeaders(headers) {
  const type = String(headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const out = { ...headers, "x-content-type-options": "nosniff" };
  if (type !== "application/pdf") out["content-security-policy"] = "sandbox";
  if (!INLINE_SAFE_TYPES.has(type)) out["content-disposition"] = "attachment";
  return out;
}

// UPLOAD BODIES ARE CAPPED HERE (File Library P0-10).
//
// Convex upload URLs (`/api/storage/upload?token=…`) accept any size, and the
// blob is written BEFORE any mutation can look at it — so the server-side size
// check in finishUpload runs only after the bytes already cost disk. This is
// the one place a body can be refused while it streams. The largest file the
// app accepts is 25 MB (libraryCore LIMITS.stored); 26 MB leaves room for
// multipart framing. Counted on the STREAM, not trusted from Content-Length:
// a chunked upload has none, and a lying one is caught by the count.
const MAX_UPLOAD_BYTES = 26 * 1024 * 1024;

function isUploadRequest(port, path) {
  return STORAGE_UPSTREAM_PORTS.has(port) && /^\/api\/storage\/upload(\?|$)/.test(path);
}

function declaredTooLarge(headers, max) {
  const n = Number(headers["content-length"]);
  return Number.isFinite(n) && n > max;
}

// A pass-through that errors the moment more than `max` bytes have flowed.
function byteCap(max) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, done) {
      seen += chunk.length;
      if (seen > max) done(Object.assign(new Error("payload too large"), { code: "E_TOO_LARGE" }));
      else done(null, chunk);
    },
  });
}

function tooLarge(req, res) {
  if (!res.headersSent) {
    res.writeHead(413, { "content-type": "text/plain", connection: "close" });
  }
  // Stop reading an upload we have refused: close the socket once the 413 is out.
  res.end("upload too large", () => req.destroy());
}

// Forward one request to 127.0.0.1:<target.port><target.path>.
function forward(req, res, target) {
  const { port, path } = target;
  const max = target.maxUpload ?? MAX_UPLOAD_BYTES;
  if (target.upload && declaredTooLarge(req.headers, max)) {
    tooLarge(req, res); // refused before a byte reaches Convex
    return;
  }
  const up = http.request(
    { host: "127.0.0.1", port, path, method: req.method, headers: safeHeaders(req.headers) },
    (r) => {
      const headers = target.storage ? storageHeaders(r.headers) : r.headers;
      res.writeHead(r.statusCode, headers);
      r.pipe(res);
    },
  );
  up.on("error", (e) => {
    // Headers already out (a mid-body failure, or a 413 we sent): nothing more
    // can be said on this response — writing a 502 now would throw.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream 127.0.0.1:${port} ${e.code || e.message}`);
  });
  if (!target.upload) {
    req.pipe(up);
    return;
  }
  const cap = byteCap(max);
  cap.on("error", () => {
    tooLarge(req, res);
    // Abort the upstream request mid-body: Convex never receives a complete
    // upload, so no blob is committed.
    up.destroy();
  });
  req.pipe(cap).pipe(up);
}

// HOST-ONLY ROUTES. The Convex site serves two paths meant for callers on
// this VM (the ticket redemption below and the host monitor's health read).
// Each needs its own secret anyway; they are also never reachable from outside.
function isPrivateSitePath(port, path) {
  return port === CONFIG.sitePort && /^\/(edge|ops)(\/|$)/.test(path);
}

// UPLOAD TICKETS (File Library disk safety). Every upload URL Convex issues
// carries a single-use ticket (`lt`) bound to one user and a byte count,
// already charged to that user's daily budget. It is redeemed here, BEFORE a
// byte is forwarded, and the body is cut off past the ticket's size. Without
// it an upload URL was an anonymous slot: bytes written, never finished, never
// charged to anyone.
const TICKET_PARAM = "lt";
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

function takeTicket(path) {
  const q = path.indexOf("?");
  if (q < 0) return { ticket: "", path };
  let ticket = "";
  const keep = [];
  for (const part of path.slice(q + 1).split("&")) {
    if (part.startsWith(`${TICKET_PARAM}=`)) {
      try {
        ticket = decodeURIComponent(part.slice(TICKET_PARAM.length + 1));
      } catch {
        ticket = "";
      }
    } else if (part) {
      keep.push(part);
    }
  }
  return { ticket, path: path.slice(0, q) + (keep.length ? `?${keep.join("&")}` : "") };
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Number.POSITIVE_INFINITY; // unmeasurable: the host monitor alerts instead
  }
}

function redeemTicket(ticket) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ ticket });
    const r = http.request(
      {
        host: "127.0.0.1",
        port: CONFIG.sitePort,
        path: "/edge/upload-ticket",
        method: "POST",
        timeout: 5000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-edge-key": CONFIG.ticketSecret,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const j = JSON.parse(data);
            resolve(j.ok && Number(j.maxBytes) > 0 ? Number(j.maxBytes) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    r.on("timeout", () => r.destroy());
    r.on("error", () => resolve(null));
    r.end(body);
  });
}

function refuse(req, res, status, reason) {
  console.log(JSON.stringify({ event: "EDGE_UPLOAD_REFUSED", status, reason }));
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "text/plain", connection: "close" });
  }
  res.end(reason, () => req.destroy());
}

async function handleUpload(req, res, target) {
  if (!CONFIG.ticketSecret) return refuse(req, res, 503, "uploads are unavailable");
  if (freeBytes(CONFIG.diskPath) < CONFIG.minFreeBytes) {
    return refuse(req, res, 507, "storage is temporarily full");
  }
  if (declaredTooLarge(req.headers, MAX_UPLOAD_BYTES)) return tooLarge(req, res);
  const { ticket, path } = takeTicket(target.path);
  if (!TICKET_RE.test(ticket)) return refuse(req, res, 403, "upload not authorised");
  const max = await redeemTicket(ticket);
  if (!max) return refuse(req, res, 403, "upload not authorised");
  forward(req, res, { ...target, path, maxUpload: Math.min(max, MAX_UPLOAD_BYTES) });
}

const server = http.createServer((req, res) => {
  const { port, path } = route(req.headers.host, req.url);
  if (isPrivateSitePath(port, path)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const target = {
    port,
    path,
    storage: isStorageResponse(port, path),
    upload: isUploadRequest(port, path),
  };
  if (target.upload) {
    handleUpload(req, res, target).catch(() => refuse(req, res, 502, "upload failed"));
    return;
  }
  forward(req, res, target);
});

server.on("upgrade", (req, socket, head) => {
  const { port, path } = route(req.headers.host, req.url);
  const up = net.connect(port, "127.0.0.1", () => {
    const lines = [`${req.method} ${path} HTTP/1.1`];
    for (const [k, v] of Object.entries(safeHeaders(req.headers)))
      lines.push(`${k}: ${v}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

// Listen only when run as the service, so tests can require the pure helpers.
if (require.main === module) {
  server.listen(CONFIG.port, "127.0.0.1", () => {
    console.log(
      `edge proxy on 127.0.0.1:${CONFIG.port}`,
      JSON.stringify({ HOST_ROUTES, PATH_ROUTES, uploadGate: Boolean(CONFIG.ticketSecret) }),
    );
  });
}

module.exports = {
  route,
  isStorageResponse,
  storageHeaders,
  safeHeaders,
  isUploadRequest,
  isPrivateSitePath,
  takeTicket,
  handleUpload,
  forward,
  CONFIG,
  MAX_UPLOAD_BYTES,
};
