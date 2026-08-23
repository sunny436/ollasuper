import { describe, expect, test } from "bun:test";
import {
  buildTimeline,
  errorCopy,
  parseEvent,
  timelineSignature,
  toolLabel,
  type TypedEvent,
} from "./agent-events";

function ev(
  type: string,
  payload: unknown,
  seq = 0,
  over: Partial<TypedEvent> = {},
): TypedEvent {
  return {
    eventId: `e${seq}`,
    seq,
    type,
    v: 1,
    ts: 1000 + seq,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    ...over,
  };
}

describe("parseEvent", () => {
  test("TOOL_CALL", () => {
    const p = parseEvent(
      ev("TOOL_CALL", {
        tool_name: "search_web",
        tool_id: "search_web",
        call_id: "c1",
        arguments: { q: "x" },
        status: "running",
      }),
    );
    expect(p).toMatchObject({
      kind: "tool_call",
      callId: "c1",
      toolName: "search_web",
      toolId: "search_web",
      status: "running",
      args: { q: "x" },
    });
  });

  test("TOOL_RESULT drops the content channel", () => {
    const p = parseEvent(
      ev("TOOL_RESULT", {
        call_id: "c1",
        status: "success",
        result: { n_results: 3 },
        content: "VERBATIM CONTEXT BLOCK — must never surface",
      }),
    );
    expect(p.kind).toBe("tool_result");
    // The parsed union has no `content` property at all.
    expect(JSON.stringify(p)).not.toContain("VERBATIM");
    expect("content" in p).toBe(false);
  });

  test("TOOL_PROGRESS clamps progress to [0,1]", () => {
    expect(parseEvent(ev("TOOL_PROGRESS", { call_id: "c1", progress: 1.7 }))).toMatchObject(
      { kind: "tool_progress", progress: 1 },
    );
    expect(parseEvent(ev("TOOL_PROGRESS", { call_id: "c1", progress: -2 }))).toMatchObject(
      { progress: 0 },
    );
  });

  test("CITATION / APPROVAL_REQUEST / ARTIFACT / FINAL / ERROR", () => {
    expect(parseEvent(ev("CITATION", { source_id: "f1", title: "Doc p.4", metadata: { page: 4 } }))).toMatchObject({
      kind: "citation",
      sourceId: "f1",
      title: "Doc p.4",
      metadata: { page: 4 },
    });
    expect(parseEvent(ev("APPROVAL_REQUEST", { approval_id: "a1", tool_name: "delete", reason: "why" }))).toMatchObject({
      kind: "approval",
      approvalId: "a1",
      toolName: "delete",
      status: "pending",
    });
    expect(parseEvent(ev("ARTIFACT", { artifact_id: "x", artifact_type: "memory" }))).toMatchObject({
      kind: "artifact",
      artifactType: "memory",
    });
    expect(parseEvent(ev("FINAL", { finishReason: "stop" }))).toMatchObject({
      kind: "final",
      finishReason: "stop",
    });
    expect(parseEvent(ev("ERROR", { code: "deadline", message: "too slow", retryable: true }))).toMatchObject({
      kind: "error",
      code: "deadline",
      retryable: true,
    });
  });

  test("unknown type and malformed payload degrade to unknown, never throw", () => {
    expect(parseEvent(ev("FUTURE_TYPE", { x: 1 })).kind).toBe("unknown");
    expect(parseEvent(ev("TOOL_CALL", "{not json")).kind).toBe("unknown"); // missing call_id after parse-fail
    expect(parseEvent(ev("TOOL_CALL", { arguments: {} })).kind).toBe("unknown"); // no call_id
  });
});

describe("buildTimeline", () => {
  test("empty → no activity", () => {
    const t = buildTimeline([]);
    expect(t.hasActivity).toBe(false);
    expect(t.runs).toHaveLength(0);
  });

  test("pairs call+result into one run with status + duration + rag files", () => {
    const t = buildTimeline([
      ev("TOOL_CALL", { call_id: "c1", tool_name: "search_knowledge", tool_id: "search_knowledge", arguments: { query: "q" } }, 0),
      ev(
        "TOOL_RESULT",
        {
          call_id: "c1",
          status: "success",
          result: { n_results: 2, files: [{ file_id: "f1", filename: "policy.pdf", page: 12 }] },
        },
        1,
        { ts: 1600 },
      ),
    ]);
    expect(t.runs).toHaveLength(1);
    const run = t.runs[0];
    expect(run?.status).toBe("success");
    expect(run?.callId).toBe("c1");
    expect(run?.endedTs).toBe(1600);
    expect(t.ragFiles).toEqual([{ fileId: "f1", filename: "policy.pdf", page: 12 }]);
  });

  test("error result marks the run failed", () => {
    const t = buildTimeline([
      ev("TOOL_CALL", { call_id: "c1", tool_name: "x", tool_id: "x" }, 0),
      ev("TOOL_RESULT", { call_id: "c1", status: "error", result: { error: "timeout" } }, 1),
    ]);
    expect(t.runs[0]?.status).toBe("error");
  });

  test("progress folds to the latest tick and changes the signature", () => {
    const t = buildTimeline([
      ev("TOOL_CALL", { call_id: "c1", tool_name: "x", tool_id: "x" }, 0),
      ev("TOOL_PROGRESS", { call_id: "c1", progress: 0.2, message: "step 1" }, 1),
      ev("TOOL_PROGRESS", { call_id: "c1", progress: 0.8, message: "step 2" }, 2),
    ]);
    expect(t.runs[0]?.progress).toEqual({ progress: 0.8, message: "step 2" });
  });

  test("citations, artifacts, approval and terminal are collected", () => {
    const t = buildTimeline([
      ev("CITATION", { source_id: "memory:1", title: "memory · fact", metadata: { kind: "fact" } }, 0),
      ev("ARTIFACT", { artifact_id: "a1", artifact_type: "memory" }, 1),
      ev("APPROVAL_REQUEST", { approval_id: "ap1", tool_name: "delete", reason: "r" }, 2),
      ev("FINAL", { finishReason: "stop" }, 3),
    ]);
    expect(t.citations[0]?.kind).toBe("memory");
    expect(t.artifacts).toHaveLength(1);
    expect(t.approval?.approvalId).toBe("ap1");
    expect(t.terminal?.kind).toBe("final");
  });

  test("citation kind is derived from source id", () => {
    const t = buildTimeline([
      ev("CITATION", { source_id: "f1", title: "Doc" }, 0),
      ev("CITATION", { source_id: "memory:9", title: "m" }, 1),
      ev("CITATION", { source_id: "https://example.com", title: "web", url: "https://example.com" }, 2),
    ]);
    expect(t.citations.map((c) => c.kind)).toEqual(["rag", "memory", "web"]);
  });

  test("out-of-order events are sorted by seq", () => {
    const t = buildTimeline([
      ev("TOOL_RESULT", { call_id: "c1", status: "success", result: {} }, 1),
      ev("TOOL_CALL", { call_id: "c1", tool_name: "x", tool_id: "x" }, 0),
    ]);
    expect(t.runs[0]?.status).toBe("success");
  });
});

describe("timelineSignature", () => {
  test("changes only when an event appends", () => {
    const a = [ev("TOOL_CALL", { call_id: "c1", tool_name: "x", tool_id: "x" }, 0)];
    const b = [...a, ev("TOOL_RESULT", { call_id: "c1", status: "success", result: {} }, 1)];
    expect(timelineSignature(a)).toBe(timelineSignature(a));
    expect(timelineSignature(a)).not.toBe(timelineSignature(b));
    expect(timelineSignature(undefined)).toBe("0:");
  });
});

describe("toolLabel", () => {
  test("reserved built-ins", () => {
    expect(toolLabel("search_knowledge", "search_knowledge").running).toBe("Reading your documents");
    expect(toolLabel("search_memory", "search_memory").icon).toBe("🧠");
  });
  test("verb heuristic for open-ended tools", () => {
    expect(toolLabel("search_web").running.toLowerCase()).toContain("searching");
    expect(toolLabel("scrape_url").running.toLowerCase()).toContain("fetching");
  });
  test("unknown tool falls back to title-cased Running", () => {
    const l = toolLabel("do_a_thing", "do_a_thing");
    expect(l.icon).toBe("🔧");
    expect(l.running).toBe("Running Do A Thing");
  });
});

describe("errorCopy", () => {
  test("known retryable code maps to friendly copy", () => {
    expect(errorCopy("deadline")).toEqual({
      message: "This response took too long and was stopped.",
      retryable: true,
    });
  });
  test("non-retryable code hides retry", () => {
    expect(errorCopy("not_configured").retryable).toBe(false);
  });
  test("unknown code falls back to the raw message and stays retryable", () => {
    expect(errorCopy("weird_code", "raw backend text")).toEqual({
      message: "raw backend text",
      retryable: true,
    });
    expect(errorCopy(null, null).message).toBe("Something went wrong.");
  });
});
