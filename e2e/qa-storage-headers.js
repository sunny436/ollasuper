// Prod: the real storage URL of the QA account's latest chat attachments, and
// the headers a browser receives for those exact bytes (audit F-02).
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");
const { account } = require("./creds");

const CVX = "https://app.ollasuper.com/__cvx";
const { email, password } = account();

(async () => {
  const c = new ConvexHttpClient(CVX);
  const r = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signIn" },
  });
  c.setAuth(r.tokens.token);
  const ws = (await c.query(anyApi.orgs.myWorkspaces, {}))[0]._id;
  const threads = await c.query(anyApi.chat.threads.list, {
    workspaceId: ws,
    paginationOpts: { numItems: 3, cursor: null },
  });
  for (const t of threads.page.slice(0, 1)) {
    const atts = await c.query(anyApi.chat.attachments.listForThread, { threadId: t._id });
    for (const a of atts) {
      const res = await fetch(a.url);
      const h = res.headers;
      console.log(
        `${a.name} [row ${a.contentType}] -> ${res.status} ` +
          `served=${h.get("content-type")} disp=${h.get("content-disposition") || "inline"} ` +
          `csp=${h.get("content-security-policy") || "-"} nosniff=${h.get("x-content-type-options")}`,
      );
    }
  }
  await c.action(anyApi.auth.signOut, {}).catch(() => {});
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
