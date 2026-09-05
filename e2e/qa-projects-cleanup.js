// Projects — remove the controlled test resources this release's suites created.
//
// Cleanup follows the REAL lifecycle, not a special back door: `projects.purge`
// is an internalMutation and is unreachable from any client, so a test Project
// can only be TRASHED — which is exactly what a user deleting it does — and the
// 6-hourly `purge trashed projects` cron reclaims it after the retention TTL.
// Files and chats are removed outright through their own public mutations.
//
//   CONVEX_URL=http://127.0.0.1:3210 node qa-projects-cleanup.js [--apply]
//
// Without --apply it only lists what it WOULD remove.
const { ConvexHttpClient } = require("convex/browser");
const { anyApi } = require("convex/server");

const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const EMAIL = process.env.ADMIN_EMAIL || "admin@myos.test";
const PASSWORD = process.env.ADMIN_PASSWORD || "MyosAdmin#2026";
const APPLY = process.argv.includes("--apply");

// Only names this release's own suites generate. Deliberately narrow: anything
// that is not obviously ours is left alone.
const TEST_NAME =
  /^(QA Alpha |QA Beta |ISO-[AB]-|RA-|RB-|RT2-|probe-[AB]-|doomed-|arch-|trash-|conv-)/;
const TEST_FILE = /^qa-projects-[a-z0-9]+\.txt$/;

async function signIn(email, password) {
  const c = new ConvexHttpClient(CONVEX_URL);
  const r = await c.action(anyApi.auth.signIn, {
    provider: "password",
    params: { email, password, flow: "signIn" },
  });
  const authed = new ConvexHttpClient(CONVEX_URL);
  authed.setAuth(r.tokens.token);
  return authed;
}

(async () => {
  const C = await signIn(EMAIL, PASSWORD);
  const wss = await C.query(anyApi.orgs.myWorkspaces, {});
  let projects = 0;
  let files = 0;

  for (const ws of wss) {
    for (const status of ["active", "archived"]) {
      let cursor = null;
      for (;;) {
        const page = await C.query(anyApi.projects.list, {
          workspaceId: ws._id,
          status,
          paginationOpts: { numItems: 50, cursor },
        });
        for (const p of page.page ?? []) {
          if (!TEST_NAME.test(p.name)) continue;
          console.log(`${APPLY ? "trash " : "would trash "} project "${p.name}" (${status})`);
          projects += 1;
          if (APPLY)
            await C.mutation(anyApi.projects.remove, { projectId: p._id }).catch(() => {});
        }
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    }

    let fcursor = null;
    for (;;) {
      const page = await C.query(anyApi.userFiles.list, {
        workspaceId: ws._id,
        paginationOpts: { numItems: 50, cursor: fcursor },
      });
      for (const f of page.page ?? []) {
        if (!TEST_FILE.test(f.name || "")) continue;
        console.log(`${APPLY ? "delete" : "would delete"} file ${f.name}`);
        files += 1;
        if (APPLY)
          await C.mutation(anyApi.userFiles.remove, { fileId: f._id }).catch((e) =>
            console.log("   (file remove failed: " + String(e.message).split("\n")[0] + ")"),
          );
      }
      if (page.isDone) break;
      fcursor = page.continueCursor;
    }
  }

  console.log(
    `\n${APPLY ? "removed" : "would remove"}: ${projects} project(s), ${files} file(s)`,
  );
  console.log(
    "Trashed Projects remain visible under Deleted until the purge cron reclaims them — that is their real lifecycle, not a leftover.",
  );
})();
