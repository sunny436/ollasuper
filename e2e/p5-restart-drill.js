// NON-DESTRUCTIVE production recovery check.
//
// Queues an occurrence, restarts the scheduler while it is still queued, and
// proves it executes EXACTLY ONCE afterwards. Graceful restart only — SIGKILL,
// PostgreSQL restarts and duplicate workers belong on the replica, never here.
//
// The property under test is the one that matters after any deploy or reboot:
// work already owed survives the process that was going to do it.
//
// Runs on the VM:  cd /opt/myos/e2e && node p5-restart-drill.js
const { execSync } = require("node:child_process");
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const MAILPIT = process.env.MAILPIT_URL || "http://127.0.0.1:8025";
const DOMAIN = process.env.E2E_EMAIL_DOMAIN || "gmail.com";

const results = [];
const ok = (n) => {
  results.push(true);
  console.log("PASS  " + n);
};
const no = (n, d) => {
  results.push(false);
  console.log("FAIL  " + n + (d ? " — " + d : ""));
};
const must = (c, n, d) => (c ? ok(n) : no(n, d));
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

async function signUp(email, password) {
  const c = new ConvexHttpClient(CONVEX_URL);
  await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signUp" },
  });
  let code = null;
  for (let i = 0; i < 14 && !code; i++) {
    code = await codeFromMailpit(email);
    if (!code) await sleep(1500);
  }
  if (!code) throw new Error("no verification code for " + email);
  const v = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, code, flow: "email-verification" },
  });
  const authed = new ConvexHttpClient(CONVEX_URL);
  authed.setAuth(v.tokens.token);
  return authed;
}

(async () => {
  const ts = Date.now();
  const user = await signUp(`schedrestart${ts}@${DOMAIN}`, "SchedRestart#2026x");
  const ws = await user.mutation(anyApi.orgs.createWorkspace, {
    name: `Restart${ts}`,
  });
  const taskId = await user.mutation(anyApi.scheduled.tasks.create, {
    workspaceId: ws,
    title: `restart-drill-${ts}`,
    prompt: "Reply with the single word: ok",
    spec: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
  });
  ok("task created");

  await user.mutation(anyApi.scheduled.tasks.runNow, { taskId });
  ok("occurrence queued");

  // Restart while it is still QUEUED — the tick that would claim it is up to
  // 30s away, so this lands squarely in the window that matters.
  execSync("systemctl restart myos-scheduler");
  console.log("      scheduler restarted");

  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    try {
      const r = await fetch("http://127.0.0.1:8771/readyz");
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
  }
  must(ready, "the scheduler came back and reports ready");

  // The occurrence must still be owed, then run.
  let history = { page: [] };
  let settled = null;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    history = await user.query(anyApi.scheduled.tasks.history, { taskId });
    const done = history.page.filter((o) =>
      ["succeeded", "failed", "cancelled"].includes(o.status),
    );
    if (done.length) {
      settled = done;
      break;
    }
  }
  must(settled !== null, "the queued occurrence survived the restart and ran");

  if (settled) {
    // EXACTLY once. A restart that re-executed owed work would show two.
    must(settled.length === 1, "it ran exactly once", `saw ${settled.length}`);
    must(
      settled[0].status === "succeeded",
      "it succeeded",
      settled[0].status + " " + (settled[0].errorCode || ""),
    );
    must(
      settled[0].attempts === 1,
      "it took one attempt — the restart did not cost a retry",
      `attempts=${settled[0].attempts}`,
    );
    const active = await user.query(anyApi.scheduled.tasks.activeRun, { taskId });
    must(active === null, "nothing is left running");
  }

  await user.mutation(anyApi.scheduled.tasks.remove, { taskId });
  ok("cleaned up");

  const passed = results.filter(Boolean).length;
  console.log(`\n===== RESTART DRILL: ${passed}/${results.length} =====`);
  if (passed !== results.length) process.exit(1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
