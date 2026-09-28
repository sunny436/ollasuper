import { describe, expect, test } from "bun:test";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import {
  type Candidate,
  type LibraryUploadDeps,
  libraryFileUrl,
  preselect,
  selectedBytes,
  sortCandidates,
  uploadToLibrary,
} from "./library";

const MB = 1024 * 1024;
const id = (s: string) => s as Id<"userFiles">;
const c = (name: string, size: number, createdAt: number): Candidate => ({
  _id: id(name),
  name,
  size,
  kind: "pdf",
  createdAt,
});
const plan = (shortBytes: number) => ({
  quotaBytes: 100 * MB,
  usedBytes: 95 * MB,
  reservedBytes: 0,
  needBytes: 10 * MB,
  shortBytes,
  canFit: true,
});
const file = (name = "report.pdf", bytes = 10) =>
  new File([new Uint8Array(bytes)], name, { type: "application/pdf" });
const WS = "ws1" as Id<"workspaces">;

function fakeDeps(over: Partial<LibraryUploadDeps> | ((calls: string[]) => Partial<LibraryUploadDeps>) = {}) {
  const calls: string[] = [];
  const extra = typeof over === "function" ? over(calls) : over;
  const deps: LibraryUploadDeps = {
    beginUpload: async (a) => {
      calls.push(`begin:${a.approvedDeletions?.join(",") ?? ""}`);
      return { ok: true, intentId: "i1" as Id<"uploadIntents">, uploadUrl: "https://u" };
    },
    finishUpload: async (a) => {
      calls.push(`finish:${a.approvedDeletions?.join(",") ?? ""}`);
      return { ok: true, fileId: id("new"), evicted: [] };
    },
    abortUpload: async (a) => {
      calls.push(`abort:${a.storageId ?? ""}`);
      return { ok: true };
    },
    send: async () => {
      calls.push("send");
      return "st1";
    },
    ...extra,
  };
  return { deps, calls };
}

describe("free up space", () => {
  const list = [c("new", 1 * MB, 30), c("old", 4 * MB, 10), c("mid", 8 * MB, 20)];

  test("pre-selects the OLDEST files, only as many as the new file needs", () => {
    expect(preselect(list, 3 * MB)).toEqual([id("old")]);
    expect(preselect(list, 5 * MB)).toEqual([id("old"), id("mid")]);
    expect(preselect(list, 0)).toEqual([]);
  });

  test("sorts by oldest or by largest without mutating the input", () => {
    expect(sortCandidates(list, "oldest").map((f) => f.name)).toEqual(["old", "mid", "new"]);
    expect(sortCandidates(list, "largest").map((f) => f.name)).toEqual(["mid", "old", "new"]);
    expect(list.map((f) => f.name)).toEqual(["new", "old", "mid"]);
  });

  test("counts the bytes of exactly the user's selection", () => {
    expect(selectedBytes(list, new Set(["new", "mid"]))).toBe(9 * MB);
    expect(selectedBytes(list, new Set())).toBe(0);
  });
});

describe("uploadToLibrary", () => {
  test("begin → send → finish, and nothing is deleted without approval", async () => {
    const { deps, calls } = fakeDeps();
    const r = await uploadToLibrary(deps, { workspaceId: WS, file: file(), purpose: "library" });
    expect(r).toEqual({ ok: true, fileId: id("new"), evicted: [] });
    expect(calls).toEqual(["begin:", "send", "finish:"]);
  });

  test("no room: returns the question and never sends a byte", async () => {
    const { deps, calls } = fakeDeps({
      beginUpload: async () => ({
        ok: false,
        reason: "NEEDS_SPACE",
        plan: plan(5 * MB),
        candidates: [c("a", 6 * MB, 1)],
      }),
    });
    const r = await uploadToLibrary(deps, { workspaceId: WS, file: file(), purpose: "chat" });
    expect(r.ok).toBe(false);
    expect("space" in r && r.space.reason).toBe("NEEDS_SPACE");
    expect(calls).toEqual([]);
  });

  test("the user's approval is passed to BOTH steps, unchanged", async () => {
    const { deps, calls } = fakeDeps();
    await uploadToLibrary(deps, {
      workspaceId: WS,
      file: file(),
      purpose: "library",
      approvedDeletions: [id("x"), id("y")],
    });
    expect(calls).toEqual(["begin:x,y", "send", "finish:x,y"]);
  });

  test("a stale approval releases the session and its blob, then asks again", async () => {
    const { deps, calls } = fakeDeps((log) => ({
      finishUpload: async (a) => {
        log.push(`finish:${a.approvedDeletions?.join(",") ?? ""}`);
        return {
          ok: false,
          code: "QUOTA_PLAN_CHANGED",
          plan: plan(2 * MB),
          candidates: [],
        };
      },
    }));
    const r = await uploadToLibrary(deps, {
      workspaceId: WS,
      file: file(),
      purpose: "library",
      approvedDeletions: [id("x")],
    });
    expect("space" in r && r.space.reason).toBe("QUOTA_PLAN_CHANGED");
    expect(calls).toEqual(["begin:x", "send", "finish:x", "abort:st1"]);
  });

  test("a failed transfer releases the reservation immediately", async () => {
    const { deps, calls } = fakeDeps({
      send: async () => {
        throw new Error("The file is too large.");
      },
    });
    await expect(
      uploadToLibrary(deps, { workspaceId: WS, file: file(), purpose: "chat" }),
    ).rejects.toThrow("too large");
    expect(calls).toEqual(["begin:", "abort:"]);
  });

  test("a server refusal is surfaced as its message", async () => {
    const { deps } = fakeDeps({
      finishUpload: async () => ({ ok: false, code: "SIZE_MISMATCH", message: "larger than declared" }),
    });
    const r = await uploadToLibrary(deps, { workspaceId: WS, file: file(), purpose: "chat" });
    expect(r).toEqual({ ok: false, message: "larger than declared" });
  });

  test("an HTML file's blob is stored under a type no browser executes", async () => {
    let storedAs = "";
    const { deps } = fakeDeps({
      send: async (_u, _f, ct) => {
        storedAs = ct;
        return "st1";
      },
    });
    const html = new File(["<script>"], "x.html", { type: "text/html" });
    await uploadToLibrary(deps, { workspaceId: WS, file: html, purpose: "library" });
    expect(storedAs).toBe("text/plain");
  });
});

describe("libraryFileUrl", () => {
  test("rides the Convex SITE path on the app's own host", () => {
    expect(libraryFileUrl("https://app.ollasuper.com/__cvx", "tok", "download")).toBe(
      "https://app.ollasuper.com/__cvx-site/library/file?t=tok",
    );
    expect(libraryFileUrl("http://172.16.70.25:3210", "tok", "preview")).toBe(
      "http://172.16.70.25:3211/library/file?t=tok&p=preview",
    );
    expect(libraryFileUrl("https://x.convex.cloud", "tok", "download")).toBe(
      "https://x.convex.site/library/file?t=tok",
    );
  });
});
