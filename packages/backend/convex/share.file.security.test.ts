/// <reference types="vite/client" />
/**
 * /share/file must never hand a browser something it will EXECUTE.
 *
 * The route streams a blob and used to set the response content-type from the
 * share snapshot, which carries `chatAttachments.contentType` — i.e.
 * `args.contentType` as supplied by the client at register(), never validated.
 * blobSafety guards the BLOB's stored type (what ctx.storage.getUrl() serves),
 * so every other surface is covered; this route re-attached the row's declared
 * value on top of the neutralised blob and put the guard back where it started.
 *
 * It matters because the route is reachable on the APP'S OWN ORIGIN
 * (app.ollasuper.com/__cvx-site/share/file) and Convex adds no nosniff or CSP of
 * its own — the Next.js headers cover :3000 only. share-attachment.tsx renders a
 * non-image as a NAVIGATED link, so opening the chip was enough to trigger it.
 *
 * These tests assert the RESPONSE HEADERS, which is the thing no existing
 * blob-safety test looked at: they all assert stored/returned types instead.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*"]);

type SeedAtt = { name: string; contentType: string; kind: string };

/** A live share whose snapshot declares `contentType` for one attachment. */
async function seedShare(t: ReturnType<typeof convexTest>, att: SeedAtt, bytes: string) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "owner@t.test" });
    const workspaceId = await ctx.db.insert("workspaces", {
      name: "WS",
      ownerId: userId,
      createdAt: Date.now(),
    });
    const chatId = await ctx.db.insert("chatThreads", {
      workspaceId,
      userId,
      title: "T",
      titleSource: "auto",
      status: "active",
      pinned: false,
      model: "qwen3.5",
      nextSeq: 1,
      messageCount: 1,
      tokensIn: 0,
      tokensOut: 0,
      lastMessageAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // The blob is stored as text/plain — exactly what an attacker would do to
    // satisfy the register()-time guard, which inspects the BLOB and not the row.
    const storageId = await ctx.storage.store(
      new Blob([bytes], { type: "text/plain" }),
    );
    const token = "a".repeat(48);
    await ctx.db.insert("chatShares", {
      token,
      userId,
      workspaceId,
      chatId,
      shareType: "full_chat",
      title: "T",
      snapshot: JSON.stringify({
        type: "full_chat",
        title: "T",
        createdAt: Date.now(),
        messages: [
          {
            role: "user",
            content: "hi",
            attachments: [
              {
                name: att.name,
                contentType: att.contentType,
                kind: att.kind,
                size: bytes.length,
                storageId,
              },
            ],
          },
        ],
      }),
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    return { token, userId: userId as Id<"users"> };
  });
}

const EXECUTABLE = [
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xslt+xml",
  "text/xsl",
  // Not in EXECUTABLE_TYPES, and that is the point: an xml-stylesheet PI makes
  // the browser transform this into same-origin HTML. An allowlist covers it;
  // the denylist never did.
  "text/xml",
  "application/xml",
];

describe("/share/file never serves an executable content-type", () => {
  for (const declared of EXECUTABLE) {
    test(`declared ${declared} is neutralised and forced to download`, async () => {
      const t = convexTest(schema, modules);
      const { token } = await seedShare(
        t,
        { name: "notes.txt", contentType: declared, kind: "document" },
        "<script>alert(document.domain)</script>",
      );

      const res = await t.fetch(`/share/file?t=${token}&m=0&a=0`, {
        method: "GET",
      });
      expect(res.status).toBe(200);

      const ct = res.headers.get("content-type") ?? "";
      // The declared type must not survive into the header at all.
      expect(ct).not.toContain(declared);
      expect(ct).toBe("application/octet-stream");
      // Downloaded, never rendered.
      expect(res.headers.get("content-disposition") ?? "").toMatch(/^attachment;/);
      // And no sniffing back into HTML.
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
  }

  test("the bytes are still delivered intact — this neutralises, it does not censor", async () => {
    const t = convexTest(schema, modules);
    const body = "<script>alert(1)</script>";
    const { token } = await seedShare(
      t,
      { name: "x.html", contentType: "text/html", kind: "document" },
      body,
    );
    const res = await t.fetch(`/share/file?t=${token}&m=0&a=0`, { method: "GET" });
    expect(await res.text()).toBe(body);
  });

  test("a filename with quotes/CRLF cannot break out of the disposition header", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedShare(
      t,
      {
        name: 'evil";\r\nx-injected: 1;"',
        contentType: "text/html",
        kind: "document",
      },
      "x",
    );
    const res = await t.fetch(`/share/file?t=${token}&m=0&a=0`, { method: "GET" });
    expect(res.headers.get("x-injected")).toBeNull();
    expect(res.headers.get("content-disposition") ?? "").not.toContain("\r");
  });
});

describe("/share/file still renders legitimate images inline", () => {
  for (const ok of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    test(`${ok} keeps its type and is NOT forced to download`, async () => {
      const t = convexTest(schema, modules);
      const { token } = await seedShare(
        t,
        { name: "pic.png", contentType: ok, kind: "image" },
        "fakebytes",
      );
      const res = await t.fetch(`/share/file?t=${token}&m=0&a=0`, {
        method: "GET",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(ok);
      // The <img> path in share-attachment.tsx depends on this staying inline.
      expect(res.headers.get("content-disposition")).toBeNull();
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
  }

  test("svg is an image everywhere else, but is NOT inline-safe here", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedShare(
      t,
      { name: "chart.svg", contentType: "image/svg+xml", kind: "image" },
      "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    );
    const res = await t.fetch(`/share/file?t=${token}&m=0&a=0`, { method: "GET" });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition") ?? "").toMatch(/^attachment;/);
  });
});

describe("the existing share guards still hold", () => {
  test("a revoked share serves nothing", async () => {
    const t = convexTest(schema, modules);
    const { token } = await seedShare(
      t,
      { name: "pic.png", contentType: "image/png", kind: "image" },
      "bytes",
    );
    await t.run(async (ctx) => {
      const s = await ctx.db
        .query("chatShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      if (s) await ctx.db.patch(s._id, { revokedAt: Date.now() });
    });
    const res = await t.fetch(`/share/file?t=${token}&m=0&a=0`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  test("an unknown token is indistinguishable from a revoked one", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(`/share/file?t=${"b".repeat(48)}&m=0&a=0`, {
      method: "GET",
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });
});
