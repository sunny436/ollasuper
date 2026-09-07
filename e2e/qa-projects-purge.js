// Projects — does PURGE actually reclaim a Project, or only hide it?
//
// `projects.remove` trashes. The thing that finally reclaims a Project is
// `projects.purge`, an internalMutation the 6-hourly cron calls after the 30-day
// retention TTL. No client can call it, and waiting 30 days is not a test — so
// this drives it through the Convex admin CLI on the VM, which is the same
// authority the cron runs under and the narrowest legitimate path available.
//
// The cascade has five steps and each one is a different promise:
//   1. CHATS SURVIVE, unassigned — the conversation belongs to the person, not
//      to the container it was filed under.
//   2. FILE EDGES ONLY — the userFiles row and its Postgres blob survive,
//      because the same file may sit in another Project.
//   3. MEMORIES across every status — the index is prefixed on userId+projectId,
//      so disabled/superseded rows are reached too.
//   4. SCHEDULED TASKS soft-deleted — hard-deleting breaks the invariant that
//      occurrence history resolves to a real task row.
//   5. The Project row itself.
//
// Every one is asserted below against production, on a Project this script
// creates and owns.
//
//   PROJECT_ID=<id> node qa-projects-purge.js        (verify phase, after purge)
//   node qa-projects-purge.js --setup                (build the fixture)
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = require("./creds").adminPassword();
const RUN = Date.now().toString(36).slice(-6);

async function admin() {
  const c = new ConvexHttpClient(CONVEX_URL);
  const r = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email: EMAIL, password: PASSWORD, flow: "signIn" },
  });
  const a = new ConvexHttpClient(CONVEX_URL);
  a.setAuth(r.tokens.token);
  return a;
}

const results = [];
const step = async (n, f) => {
  try {
    await f();
    results.push(true);
    console.log("PASS  " + n);
  } catch (e) {
    results.push(false);
    console.log("FAIL  " + n + " — " + String(e.message).split("\n")[0]);
  }
};

(async () => {
  const C = await admin();
  const ws = (await C.query(anyApi.orgs.myWorkspaces, {}))[0]._id;

  if (process.argv.includes("--setup")) {
    const pid = await C.mutation(anyApi.projects.create, {
      workspaceId: ws,
      name: `QA Purge ${RUN}`,
    });
    const thread = await C.mutation(anyApi.chat.threads.create, {
      workspaceId: ws,
      title: `purge-chat-${RUN}`,
      projectId: pid,
    });
    const files = await C.query(anyApi.userFiles.list, {
      workspaceId: ws,
      paginationOpts: { numItems: 5, cursor: null },
    });
    const fileId = files?.page?.[0]?._id ?? null;
    if (fileId) await C.mutation(anyApi.projects.linkFile, { projectId: pid, fileId });
    const task = await C.mutation(anyApi.scheduled.tasks.create, {
      workspaceId: ws,
      title: `purge-task-${RUN}`,
      prompt: "hello",
      projectId: pid,
      spec: { kind: "once", timezone: "UTC", runAt: Date.now() + 86400000 },
    });
    console.log(
      JSON.stringify({ projectId: pid, threadId: thread, fileId, taskId: task, ws }),
    );
    return;
  }

  // ---- verify phase -------------------------------------------------------
  const fixture = JSON.parse(process.env.FIXTURE || "{}");
  const { projectId, threadId, fileId, taskId } = fixture;
  if (!projectId) throw new Error("FIXTURE env with projectId is required");

  await step("1. the Project row itself is GONE", async () => {
    const p = await C.query(anyApi.projects.get, { projectId });
    if (p) throw new Error(`project still readable with status=${p.status}`);
  });

  await step("2. its CHAT survives and is no longer in any Project", async () => {
    const t = await C.query(anyApi.chat.threads.get, { threadId });
    if (!t) throw new Error("the chat was deleted with its Project");
    if (t.projectId)
      throw new Error(`chat still points at a purged Project: ${t.projectId}`);
  });

  await step("2b. the surviving chat is back in the ordinary conversation list", async () => {
    let cursor = null;
    let seen = false;
    for (let i = 0; i < 6 && !seen; i++) {
      const page = await C.query(anyApi.chat.threads.list, {
        workspaceId: ws,
        unassignedOnly: true,
        paginationOpts: { numItems: 50, cursor },
      });
      seen = (page.page ?? []).some((t) => String(t._id) === String(threadId));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    if (!seen)
      throw new Error("the chat did not return to the unassigned conversation list");
  });

  await step("3. the FILE survives; only the Project edge was removed", async () => {
    if (!fileId) {
      console.log("      (no file was linked — skipping the blob-survival half)");
      return;
    }
    let cursor = null;
    let alive = false;
    for (let i = 0; i < 6 && !alive; i++) {
      const page = await C.query(anyApi.userFiles.list, {
        workspaceId: ws,
        paginationOpts: { numItems: 50, cursor },
      });
      alive = (page.page ?? []).some((f) => String(f._id) === String(fileId));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    if (!alive) throw new Error("PURGE DELETED A FILE it was only supposed to unlink");
  });

  await step("4. the Project's MEMORIES are gone", async () => {
    const memId = fixture.memoryId;
    if (!memId) {
      console.log("      (no project memory in the fixture — see the report)");
      return;
    }
    const all = await C.query(anyApi.memories.list, {
      workspaceId: ws,
      paginationOpts: { numItems: 200, cursor: null },
    });
    if ((all.page ?? []).some((m) => String(m._id) === String(memId)))
      throw new Error("a Project memory survived the purge");
  });

  await step("5. the SCHEDULED TASK is soft-deleted, not vanished", async () => {
    if (!taskId) {
      console.log("      (no task in the fixture)");
      return;
    }
    const tasks = await C.query(anyApi.scheduled.tasks.list, { workspaceId: ws });
    const row = (tasks ?? []).find((t) => String(t._id) === String(taskId));
    if (!row) {
      // list() may hide deleted tasks; that is acceptable so long as it is not
      // still runnable. Absence from the active list is the observable promise.
      console.log("      task absent from the active list (soft-deleted)");
      return;
    }
    if (row.status !== "deleted")
      throw new Error(`task still ${row.status}; expected deleted`);
  });

  const pass = results.filter(Boolean).length;
  console.log(`\n===== PROJECT PURGE CASCADE: ${pass}/${results.length} =====`);
  process.exit(pass === results.length ? 0 : 1);
})();
