"""`humanize_check` — the reserved DETERMINISTIC built-in behind the stage.

Two modes, the `marketing_calc` shape (`kind`/`mode` dispatch, stateless,
read-only, never raises — a bad shape comes back as `{"error": ...}`):

  detect  {text, sample?, keywords?, register?}  -> score, verdict, findings
  verify  {before, after, keywords?, register?}  -> nothing lost, nothing invented

WHY A TOOL AND NOT A PROMPT RULE. The Finance work established the house rule:
prompts do not enforce numbers. "Does this read like a person wrote it?" is the
same kind of question — a model asked to grade its own prose will say yes. The
detector computes it, so the gate is real and the same text always scores the
same.

THE PAYLOAD IS BUDGETED. `ai_agent_tool_result_max_chars` is 8,000 and the
executor truncates above it, which would silently cut the findings list in half
and leave the model fixing a subset it cannot see the end of. `detect` therefore
returns the most severe findings in full and COUNTS for the rest, and trims
itself until it fits.
"""

from __future__ import annotations

import json
from typing import Any

from app.humanizer.patterns import (
    DEFAULT_THRESHOLD,
    Finding,
    analyze,
    human_voice_score,
)
from app.humanizer.preserve import verify as _verify

HUMANIZE_CHECK_TOOL_NAME = "humanize_check"

#: Under the executor's 8,000-char result cap with room for the wrapper.
_MAX_PAYLOAD_CHARS = 6500
_MAX_FINDINGS = 30
_MAX_EXCERPT = 80
_MAX_TEXT = 200_000


def _clean_keywords(value: Any) -> tuple[str, ...]:
    if isinstance(value, str):
        value = [v for v in value.split(",")]
    if not isinstance(value, list):
        return ()
    return tuple(v.strip() for v in value if isinstance(v, str) and v.strip())[:40]


def _register(value: Any) -> str:
    return "technical" if str(value or "").strip().lower() == "technical" else "prose"


def _render(f: Finding) -> dict[str, Any]:
    return {
        "id": f.pattern,
        "name": f.name,
        "category": f.category,
        "severity": f.severity,
        "at": f.start,
        "text": f.excerpt[:_MAX_EXCERPT],
    }


def _fit(payload: dict[str, Any]) -> dict[str, Any]:
    """Trim the findings list until the serialized result fits the cap."""
    while len(json.dumps(payload, separators=(",", ":"))) > _MAX_PAYLOAD_CHARS:
        shown = payload.get("findings") or []
        if len(shown) <= 3:
            payload["findings"] = shown[:3]
            payload["truncated"] = True
            break
        payload["findings"] = shown[: max(3, len(shown) // 2)]
        payload["truncated"] = True
    return payload


def _detect(args: dict) -> dict[str, Any]:
    text = args.get("text")
    if not isinstance(text, str) or not text.strip():
        return {"error": "detect needs `text` (the draft to check)"}
    if len(text) > _MAX_TEXT:
        return {"error": f"text is longer than {_MAX_TEXT} characters"}
    sample = args.get("sample") if isinstance(args.get("sample"), str) else None
    register = _register(args.get("register"))
    threshold = args.get("threshold")
    gate = int(threshold) if isinstance(threshold, (int, float)) else DEFAULT_THRESHOLD
    gate = max(0, min(100, gate))

    findings, prof = analyze(text, sample=sample, register=register)
    score = human_voice_score(text, register=register, findings=findings, prof=prof)
    by_pattern: dict[str, int] = {}
    for f in findings:
        by_pattern[f.pattern] = by_pattern.get(f.pattern, 0) + 1
    ranked = sorted(findings, key=lambda f: (f.severity != "act", f.start))
    payload: dict[str, Any] = {
        "mode": "detect",
        "human_voice_score": score,
        "threshold": gate,
        # THE CONDITIONAL RULE, computed rather than left to judgement: text that
        # already reads human is shipped untouched, because a rewrite is the only
        # way to lose a fact.
        "verdict": "ship_as_is" if score >= gate else "revise",
        "words": prof.words,
        "findings_total": len(findings),
        "counts_by_pattern": by_pattern,
        "findings": [_render(f) for f in ranked[:_MAX_FINDINGS]],
        "register": register,
        "voice_sample_used": bool(sample and sample.strip()),
    }
    if len(findings) > _MAX_FINDINGS:
        payload["truncated"] = True
    return _fit(payload)


def _verify_mode(args: dict) -> dict[str, Any]:
    before, after = args.get("before"), args.get("after")
    if not isinstance(before, str) or not isinstance(after, str):
        return {
            "error": "verify needs `before` and `after` (the draft and the rewrite)"
        }
    if len(before) > _MAX_TEXT or len(after) > _MAX_TEXT:
        return {"error": f"text is longer than {_MAX_TEXT} characters"}
    report = _verify(
        before,
        after,
        keywords=_clean_keywords(args.get("keywords")),
        register=_register(args.get("register")),
    )
    if "error" in report:
        return report
    report["mode"] = "verify"
    return _fit(report)


def compute_humanize_check(args: Any) -> dict[str, Any]:
    """Dispatch on `mode`. Never raises: a bad shape is an `{"error": ...}`."""
    if not isinstance(args, dict):
        return {"error": "arguments must be an object"}
    mode = str(args.get("mode") or "").strip().lower()
    try:
        if mode == "detect":
            return _detect(args)
        if mode == "verify":
            return _verify_mode(args)
    except Exception as exc:  # noqa: BLE001 — a checker must never break a turn
        return {"error": f"humanize_check failed: {type(exc).__name__}"}
    return {"error": "mode must be 'detect' or 'verify'"}


HUMANIZE_CHECK_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": HUMANIZE_CHECK_TOOL_NAME,
        "description": (
            "Check whether written content reads like a person wrote it, and "
            "verify that a rewrite kept every fact. Call it with mode='detect' on "
            "your FINISHED draft before you deliver any written deliverable (an "
            "article, post, report, email, summary, section of copy). It returns a "
            "computed human_voice_score plus the exact spans that read as "
            "machine-written. If the verdict is 'ship_as_is', deliver the draft "
            "UNCHANGED — do not rewrite it. If the verdict is 'revise', rewrite "
            "ONLY the spans it names and then call mode='verify' with the original "
            "draft as `before` and your rewrite as `after`; restore anything it "
            "reports under `lost` and remove anything under `added_claims` before "
            "delivering. Pass `keywords` when the piece has required terms, "
            "`sample` when the user supplied writing of their own to match, and "
            "register='technical' for reference, API, legal or compliance text. "
            "This is an internal editing step: never mention it, never show its "
            "score, and never add a section about it to your answer."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "mode": {"type": "string", "enum": ["detect", "verify"]},
                "text": {
                    "type": "string",
                    "description": "detect: the full draft to check.",
                },
                "before": {
                    "type": "string",
                    "description": "verify: the draft as it was before the rewrite.",
                },
                "after": {
                    "type": "string",
                    "description": "verify: the rewritten draft.",
                },
                "keywords": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Required terms that must survive the rewrite.",
                },
                "sample": {
                    "type": "string",
                    "description": (
                        "The user's own writing, used as the voice reference."
                    ),
                },
                "register": {
                    "type": "string",
                    "enum": ["prose", "technical"],
                    "description": (
                        "'technical' keeps reference/legal/API text neutral."
                    ),
                },
                "threshold": {
                    "type": "integer",
                    "description": "Ship-as-is score. Default 85.",
                },
            },
            "required": ["mode"],
        },
    },
}
