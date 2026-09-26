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
const http = require("node:http");
const net = require("node:net");

const HOST_ROUTES = {
  "app.ollasuper.com": 3000,
  "convex.ollasuper.com": 3210,
  "convex-site.ollasuper.com": 3211,
};
const PATH_ROUTES = [
  { prefix: "/__cvx-site", port: 3211 },
  { prefix: "/__cvx", port: 3210 },
];
const DEFAULT = 3000;

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
const STORAGE_UPSTREAM_PORTS = new Set([3210, 3211]);
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

const server = http.createServer((req, res) => {
  const { port, path } = route(req.headers.host, req.url);
  const up = http.request(
    { host: "127.0.0.1", port, path, method: req.method, headers: safeHeaders(req.headers) },
    (r) => {
      const headers = isStorageResponse(port, path)
        ? storageHeaders(r.headers)
        : r.headers;
      res.writeHead(r.statusCode, headers);
      r.pipe(res);
    },
  );
  up.on("error", (e) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream 127.0.0.1:${port} ${e.code || e.message}`);
  });
  req.pipe(up);
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
  server.listen(5150, "127.0.0.1", () => {
    console.log("edge proxy on 127.0.0.1:5150", JSON.stringify({ HOST_ROUTES, PATH_ROUTES }));
  });
}

module.exports = { route, isStorageResponse, storageHeaders, safeHeaders };
