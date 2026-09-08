import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A maintained invariant, not a point-in-time audit.
 *
 * Blob ownership is enforced today at every mint/serve site: chat reads go
 * through requireAttachmentAccess/requireThreadAccess, files through
 * requireMember, artifacts through `getAuthUserId === parent.userId`, the share
 * proxy through a revocable token, and every /ai/* ingress through a
 * capability-scoped resolver (attachmentInStream / stagingBlobForFile /
 * resolveDownload / resolveAttachment) that pins the blob to its stream's own
 * user and thread. storageId is never returned from a public function.
 *
 * The risk is not today's code — it is the getUrl someone adds NEXT, in a new
 * query, without an ownership check. This test makes every blob-touching site
 * declare itself: each `ctx.storage.getUrl(` / `ctx.storage.get(` must sit in a
 * file that also references an authorization primitive, OR carry an explicit
 * `blob-ok:` justification comment on the same or previous line. A new unguarded
 * mint site satisfies neither and fails here.
 */
function convexSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "_generated") out.push(...convexSources(p));
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

// Any of these appearing in the file means the file participates in an
// authorization decision. Coarse on purpose: the point is that a blob-serving
// module cannot be authorization-free.
const AUTHZ =
  /getAuthUserId|requireUserId|requireMember|requireRole|requireThreadAccess|requireAttachmentAccess|attachmentInStream|stagingBlobForFile|resolveDownload|resolveAttachment|authorizeIngress|internalQuery|internalAction|internalMutation|blob-ok:/;

const MINT = /ctx\.storage\.(getUrl|get)\s*\(/;

describe("no blob path escapes ownership enforcement", () => {
  test("every storage.getUrl/get sits in a module that makes an authz decision", () => {
    const offenders: string[] = [];
    for (const file of convexSources("convex")) {
      // blobSafety is the operator-run remediation tool (admin-key internal
      // actions); it is allowed to touch blobs by id and declares itself via
      // its internal* wrappers, which AUTHZ already matches.
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!MINT.test(line)) return;
        const near = `${lines[i - 1] ?? ""}\n${line}`;
        if (!AUTHZ.test(src) && !/blob-ok:/.test(near)) {
          offenders.push(`${file}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
