// Does a chat turn actually produce an answer, right now, on this deployment?
// No browser, no fixtures — sign in, send, poll the message. Runs on the VM.
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const MAILPIT = process.env.MAILPIT_URL || "http://127.0.0.1:8025";
const DOMAIN = process.env.E2E_EMAIL_DOMAIN || "gmail.com";
const MODEL = process.env.PROBE_MODEL || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function codeFromMailpit(email) {
  try {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(email)}`);
    const j = await r.json();
    for (const m of j.messages || []) {
      const d = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
      const hit = `${d.Text || ""}${d.Subject || ""}`.match(/\b(\d{8})\b/);
      if (hit) return hit[1];
    }
  } catch {}
  return null;
}

(async () => {
  const ts = Date.now();
  const email = `chatprobe${ts}@${DOMAIN}`;
  const c = new ConvexHttpClient(CONVEX_URL);
  await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password: "ChatProbe#2026x", flow: "signUp" },
  });
  let code = null;
  for (let i = 0; i < 14 && !code; i++) {
    code = await codeFromMailpit(email);
    if (!code) await sleep(1500);
  }
  if (!code) throw new Error("no verification code");
  const v = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, code, flow: "email-verification" },
  });
  const u = new ConvexHttpClient(CONVEX_URL);
  u.setAuth(v.tokens.token);

  const ws = await u.mutation(anyApi.orgs.createWorkspace, { name: `Probe${ts}` });
  if (MODEL) {
    await u.mutation(anyApi.chat.settings.upsert, {
      workspaceId: ws,
      defaultModel: MODEL,
    });
  }
  const threadId = await u.mutation(anyApi.chat.threads.create, { workspaceId: ws });
  const thread = await u.query(anyApi.chat.threads.get, { threadId });
  console.log(`  model in use: ${thread?.model}`);

  const t0 = Date.now();
  await u.mutation(anyApi.chat.messages.send, {
    threadId,
    content: "Reply with exactly: ok",
    clientId: `probe-${ts}`,
  });

  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const { page } = await u.query(anyApi.chat.messages.listPaged, {
      threadId,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const reply = page.find((m) => m.role === "assistant" && m.status === "complete");
    if (reply) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  REPLY in ${secs}s: ${JSON.stringify(String(reply.content).slice(0, 90))}`);
      console.log(String(reply.content).trim() ? "  RESULT: chat works" : "  RESULT: EMPTY reply");
      process.exit(String(reply.content).trim() ? 0 : 1);
    }
    const failed = page.find((m) => m.role === "assistant" && m.status === "error");
    if (failed) {
      console.log(`  RESULT: FAILED — ${JSON.stringify(failed).slice(0, 300)}`);
      process.exit(1);
    }
  }
  console.log("  RESULT: TIMED OUT after 120s with no terminal assistant message");
  process.exit(1);
})().catch((e) => {
  console.error("FATAL", e.message || e);
  process.exit(1);
});
