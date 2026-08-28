"""Recover gpt-5.6-luna "harmony" tool-call leaks.

The Ollima/TensorZero gateway intermittently serializes tool calls into the
assistant message's TEXT instead of the structured `tool_calls` field, e.g.

    to=functions.batch_scrape_endpoint_v1_scrape_batch_post code:
    {"urls": [...]}
    to=functions.find_capabilities code:\n{"query": "..."}
    to=functions.seo_redirect_chain_endpoint... (json<garbage> {"url": "..."}
    multi_tool_use.parallel (json {"tool_uses": [{"recipient_name": "functions.X",
                                                  "parameters": {...}}, ...]})

When that happens the graph's `route_after_model` sees no `tool_calls`, ends the
step, the calls never run (breaking multi-step audits), and the raw text streams
to the user. This module RECOVERS the leaked calls back into real tool calls (so
they execute) and STRIPS the harmony spans from user-visible text — WITHOUT ever
eating real report prose (a stray `to=functions.X (json# Heading` keeps `# Heading`).

The durable fix is in the gateway (emit proper `tool_calls`); this is the
pragmatic app-side recovery. It is a NO-OP on any text without a harmony marker,
so non-luna models and normal answers are byte-identical.
"""

from __future__ import annotations

import json
import re
import uuid

# A leaked call opens with one of these. `to=functions.NAME` carries the bound
# (OpenAI-legal) tool name the executor already resolves via name_to_tool_id.
_MARKER_RE = re.compile(
    r"to=functions\.(?P<name>[A-Za-z0-9_.\-]+)"
    r"|(?:to=)?multi_tool_use\.parallel"
)
# The separator that may sit between the marker and its JSON args.
_SEP_RE = re.compile(r"[ \t]*(?:\(json|code:|json|\()")
# Stray harmony channel control tokens (pure noise if they leak).
_CTRL_RE = re.compile(r"<\|[^|>]*\|>")
# How far past a marker to look for its `{...}` args before giving up.
_SCAN_WINDOW = 200


def _extract_balanced_json(s: str, start: int) -> tuple[str, int] | None:
    """`s[start]` is '{'. Return (object_text, end_index) for the balanced object,
    respecting strings/escapes; None if it never closes (truncated stream)."""
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        c = s[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return s[start : i + 1], i + 1
    return None


def _scan_after_marker(text: str, pos: int) -> tuple[int | None, int, str]:
    """From `pos` (just after a marker) find the args JSON or the strip boundary.

    Returns (json_start, boundary, reason):
      - (i, i, "json")      args JSON begins at i (strip marker..json-end).
      - (None, b, reason)   no args; strip only marker..b, so prose after b is KEPT.
    `reason` ("json"/"marker"/"heading"/"newline"/"end") lets the streaming filter
    tell a settled boundary (marker/heading) from one where JSON may still arrive
    (newline/end at the buffer edge).
    """
    n = len(text)
    limit = min(n, pos + _SCAN_WINDOW)
    # A `#` glued right onto the separator (`(json# Heading`) is real prose, not
    # args — cut before it. Only within the first few chars after the marker.
    near = min(n, pos + 8)
    i = pos
    while i < limit:
        c = text[i]
        if c == "{":
            return i, i, "json"
        m = _MARKER_RE.match(text, i)
        if m:  # next leaked call — this one had no args; strip the garbage between
            return None, i, "marker"
        if c == "#" and i < near:
            return None, i, "heading"
        if c == "\n":
            j = i + 1
            while j < n and text[j] in " \t":
                j += 1
            if j < n and text[j] == "{":  # `code:\n{` / `(json ...\n{`
                i = j
                continue
            return None, i, "newline"  # newline then prose → keep the prose
        i += 1
    # Nothing conclusive in the window: strip only the marker + its separator
    # token, so at most a few chars of any real prose are lost.
    sep = _SEP_RE.match(text, pos)
    return None, sep.end() if sep else pos, "end"


def _mk_call(name: str, args: dict) -> dict:
    return {
        "name": name,
        "args": args,
        "id": "harmony_" + uuid.uuid4().hex[:16],
        "type": "tool_call",
    }


def _expand_parallel(obj: dict) -> list[dict]:
    """`multi_tool_use.parallel` wraps a list of real calls."""
    calls: list[dict] = []
    for use in obj.get("tool_uses") or []:
        if not isinstance(use, dict):
            continue
        name = str(use.get("recipient_name") or "").removeprefix("functions.")
        params = use.get("parameters")
        if name and isinstance(params, dict):
            calls.append(_mk_call(name, params))
    return calls


def parse_harmony_calls(text: str) -> tuple[list[dict], str]:
    """Split leaked harmony tool calls out of `text`.

    Returns (recovered_calls, cleaned_text). A NO-OP (returns ([], text)) when no
    marker is present, so it is safe to call on every message.
    """
    if "to=functions." not in text and "multi_tool_use.parallel" not in text:
        return [], _CTRL_RE.sub("", text) if "<|" in text else text
    calls: list[dict] = []
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        m = _MARKER_RE.search(text, i)
        if not m:
            out.append(text[i:])
            break
        out.append(text[i : m.start()])  # keep text before the marker
        name = m.group("name")  # None for a parallel wrapper
        jstart, boundary, _ = _scan_after_marker(text, m.end())
        if jstart is not None:
            extracted = _extract_balanced_json(text, jstart)
            if extracted:
                obj_str, jend = extracted
                try:
                    args = json.loads(obj_str)
                except (ValueError, TypeError):
                    args = None
                if args is not None:
                    if name is None:
                        calls.extend(_expand_parallel(args))
                    elif isinstance(args, dict):
                        calls.append(_mk_call(name, args))
                i = jend
                while i < n and text[i] in " \t":  # swallow trailing padding
                    i += 1
                continue
            # Truncated/unbalanced JSON: fall through and strip to the boundary.
        i = boundary
    cleaned = "".join(out)
    if "<|" in cleaned:
        cleaned = _CTRL_RE.sub("", cleaned)
    return calls, cleaned


def recover_into_message(response: object) -> bool:
    """Mutate an AIMessage in place: append any leaked calls to `tool_calls` and
    replace `content` with the cleaned text. Returns True if anything changed.

    Dedups recovered calls against real ones already present (same name+args) so a
    call the model emitted BOTH properly and as text is not run twice.
    """
    content = getattr(response, "content", None)
    if not isinstance(content, str) or (
        "to=functions." not in content and "multi_tool_use.parallel" not in content
    ):
        return False
    calls, cleaned = parse_harmony_calls(content)
    existing = list(getattr(response, "tool_calls", None) or [])
    seen = {
        (c.get("name"), json.dumps(c.get("args"), sort_keys=True)) for c in existing
    }
    fresh = [
        c
        for c in calls
        if (c["name"], json.dumps(c["args"], sort_keys=True)) not in seen
    ]
    if not fresh and cleaned == content:
        return False
    if fresh:
        try:
            response.tool_calls = existing + fresh  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            return False
    try:
        response.content = cleaned  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass
    return True


class HarmonyStreamFilter:
    """Strip harmony spans from the user-visible stream, robust to chunk splits.

    Holds text from the first unresolved marker (or a partial marker prefix at the
    tail) until it resolves or the stream ends, so a marker split across chunks is
    never leaked. Passes text through untouched until a marker appears.
    """

    # Longest literal prefix we must guard at a chunk tail.
    _PREFIXES = (
        "to=functions.",
        "to=multi_tool_use.parallel",
        "multi_tool_use.parallel",
    )

    def __init__(self) -> None:
        self._pending = ""

    @staticmethod
    def _partial_tail(buf: str) -> int:
        """Length of a trailing run that is a prefix of a marker literal (hold it)."""
        for p in HarmonyStreamFilter._PREFIXES:
            k = min(len(buf), len(p) - 1)
            while k > 0:
                if buf.endswith(p[:k]):
                    return k
                k -= 1
        return 0

    @staticmethod
    def _last_marker(buf: str) -> int:
        a = buf.rfind("to=functions.")
        b = buf.rfind("multi_tool_use.parallel")
        return max(a, b)

    @staticmethod
    def _tail_is_open(buf: str, pos: int) -> bool:
        """True if the marker at `pos` might still be receiving more characters
        (its args JSON hasn't closed, or an arg-less span ran to the buffer end)."""
        m = _MARKER_RE.match(buf, pos)
        if not m:  # a partial marker prefix — definitely still growing
            return True
        jstart, _boundary, reason = _scan_after_marker(buf, m.end())
        if reason == "json":
            return _extract_balanced_json(buf, jstart) is None
        # "newline"/"end" sit at the buffer edge — JSON may still arrive, so hold.
        # "marker"/"heading" are settled boundaries; the span is complete.
        return reason in ("newline", "end")

    def feed(self, text: str) -> str:
        self._pending += text
        buf = self._pending
        last = self._last_marker(buf)
        if last == -1:
            # No complete marker: emit all but a possible partial-marker tail.
            keep = self._partial_tail(buf)
            self._pending = buf[len(buf) - keep :] if keep else ""
            return buf[: len(buf) - keep] if keep else buf
        if self._tail_is_open(buf, last):
            # The last span is unfinished — emit everything before it (resolving
            # any earlier complete spans), hold from the open marker onward.
            _, cleaned = parse_harmony_calls(buf[:last])
            self._pending = buf[last:]
            return cleaned
        # Every span is closed: strip them all, then still guard a trailing
        # partial-marker prefix in what remains.
        _, cleaned = parse_harmony_calls(buf)
        keep = self._partial_tail(cleaned)
        self._pending = cleaned[len(cleaned) - keep :] if keep else ""
        return cleaned[: len(cleaned) - keep] if keep else cleaned

    def flush(self) -> str:
        _, cleaned = parse_harmony_calls(self._pending)
        self._pending = ""
        return cleaned
