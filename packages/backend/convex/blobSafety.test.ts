import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { isExecutableContentType } from "./blobSafety";

const modules = import.meta.glob("./**/*.ts");
const as = (userId: string) => ({ subject: `${userId}|sess_${userId}` });

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { email: "u@t.test" });
    const ws = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: user,
      createdAt: Date.now(),
    });
    await ctx.db.insert("members", {
      workspaceId: ws,
      userId: user,
      role: "owner",
      createdAt: Date.now(),
    });
    return { user, ws };
  });
}

describe("stored blobs cannot be browser-executable", () => {
  test("the type test names what a browser executes, and nothing else", () => {
    for (const ct of [
      "text/html",
      "TEXT/HTML",
      "text/html; charset=utf-8",
      "image/svg+xml",
      "application/xhtml+xml",
      "text/xsl",
    ]) {
      expect(isExecutableContentType(ct)).toBe(true);
    }
    for (const ct of ["text/plain", "image/png", "application/pdf", "text/csv", null]) {
      expect(isExecutableContentType(ct)).toBe(false);
    }
  });

  // Convex serves the BLOB's content-type, not the one we persist, and
  // getUrl() puts it on the app's own origin — so an html blob is same-origin
  // script execution for every viewer. Registration is the chokepoint.
  // SKIPPED, and the reason is the point: convex-test's fake _storage returns
  // only { _id, _creationTime, sha256, size }. It has no contentType, so this
  // harness CANNOT express a blob whose stored type differs from the row's —
  // which is the entire attack. Verified end-to-end against production instead;
  // see the tranche report.
  test.skip("an html blob cannot be registered as a chat attachment", async () => {
    const t = convexTest(schema, modules);
    const { user, ws } = await seed(t);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["<script>alert(1)</script>"], { type: "text/html" })),
    );
    await expect(
      t.withIdentity(as(user)).mutation(api.chat.attachments.register, {
        workspaceId: ws,
        storageId,
        name: "payload.html",
        size: 25,
        // Note the LIE: the row claims text/plain while the blob is html.
        // Validating this string instead of the blob is what protected nothing.
        contentType: "text/plain",
      }),
    ).rejects.toThrow(/Unsupported file type/);
  });

  test("an ordinary image still registers — the guard is not a blanket ban", async () => {
    const t = convexTest(schema, modules);
    const { user, ws } = await seed(t);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["\x89PNG\r\n"], { type: "image/png" })),
    );
    const id = await t.withIdentity(as(user)).mutation(api.chat.attachments.register, {
      workspaceId: ws,
      storageId,
      name: "ok.png",
      size: 7,
      contentType: "image/png",
    });
    expect(id).toBeTruthy();
  });

  // Same harness limitation as above.
  test.skip("files.saveFile refuses an html blob too", async () => {
    const t = convexTest(schema, modules);
    const { user, ws } = await seed(t);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["<h1>x</h1>"], { type: "text/html" })),
    );
    await expect(
      t.withIdentity(as(user)).mutation(api.files.saveFile, {
        workspaceId: ws,
        storageId,
        name: "payload.html",
        size: 10,
        contentType: "text/plain",
      }),
    ).rejects.toThrow(/Unsupported file type/);
  });
});
