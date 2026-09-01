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
const ollastack = require("./_lib/ollastack");

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

/**
 * A verification code, from wherever this deployment actually delivers mail.
 *
 * Ollastack first: once a real transport is configured, mail no longer reaches
 * the local Mailpit catcher at all, so reading Mailpit would look exactly like
 * "the code never arrived". Mailpit stays as the fallback for a replica.
 */
async function getVerificationCode(email) {
  if (ollastack.enabled()) {
    return await ollastack.codeForAddress(email, "verification", 120000);
  }
  return await codeFromMailpit(email);
}

/**
 * A real, run-isolated address.
 *
 * The old `<prefix><ts>@gmail.com` shape was harmless while every message went
 * to a local catcher. With a real transport it sends to NONEXISTENT Gmail
 * addresses, and every one of those bounces against a shared sending domain's
 * reputation. So the address has to be a mailbox that genuinely exists.
 */
async function testAddress(prefix) {
  if (ollastack.enabled()) return await ollastack.addressFor(prefix);
  return `${prefix}@${typeof DOMAIN === "string" ? DOMAIN : "myos.test"}`;
}

async function signUp(email, password) {
  const c = new ConvexHttpClient(CONVEX_URL);
  await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signUp" },
  });
  let code = null;
  for (let i = 0; i < 14 && !code; i++) {
    code = await getVerificationCode(email);
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
  const user = await signUp(await testAddress(`schedrestart${ts}`), "SchedRestart#2026x");
  const ws = await user.mutation(anyApi.orgs.createWorkspace, {
    name: `Restart${ts}`,
  });
  // Pin a model that is actually serving.
  //
  // This drill measures RESTART RECOVERY. Leaving the account on whatever
  // DEFAULT_MODEL happens to be conflates that with model availability at the
  // provider — which is not hypothetical: production's default (gpt-5.6-luna)
  // was returning 502 from the provider's upstream while three other models
  // answered 200, and this drill reported a scheduling failure for it.
  const MODEL = process.env.E2E_MODEL || "glm-5.2";
  await user.mutation(anyApi.chat.settings.upsert, {
    workspaceId: ws,
    defaultModel: MODEL,
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
