"""Secret detection + redaction for security turns (a gitleaks-style rule subset).

A detected value is replaced by `[REDACTED:<rule> fp=<sha256[:12]>]` BEFORE it can
reach the model, a tool event, the durable ledger, a log or the report. The
fingerprint is the finding's stable identity; the value itself never leaves. Two
passes that see the same secret produce the same marker, and a marker never
re-matches, so redaction is idempotent.

Honest limit: rules are shape-based. A secret with no recognisable shape and no
tell-tale assignment name is not caught — the report says secret coverage is
"rule-based", never "complete".
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from typing import Any

from app.logging import redact_text as _log_redact

_MARKER = "[REDACTED:"

# (rule id, pattern). A named group `v` marks the secret VALUE inside a wider
# match (the key name stays readable: `password = [REDACTED:...]`); without it the
# whole match is the value.
_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "private-key",
        re.compile(
            r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]{16,8192}?"
            r"-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----"
        ),
    ),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    (
        "aws-secret-key",
        re.compile(
            r"(?i)aws[\w.-]{0,20}(?:secret|private)[\w.-]{0,20}\\?[\"']?\s*[:=]\s*"
            r"\\?[\"']?(?P<v>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])"
        ),
    ),
    ("github-token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b")),
    ("github-pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,255}\b")),
    ("slack-token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,200}\b")),
    ("stripe-live-key", re.compile(r"\b(?:sk|rk)_live_[A-Za-z0-9]{16,200}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("openai-key", re.compile(r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,200}\b")),
    (
        "jwt",
        re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
    ),
    (
        "generic-secret-assignment",
        re.compile(
            r"(?i)\b[\w.-]{0,40}?(?:password|passwd|pwd|secret|client_secret|api[_-]?key|"
            r"apikey|access[_-]?token|auth[_-]?token|private[_-]?key|token)\b"
            r"\\?[\"']?\s*(?::=|=>|[:=])\s*\\?[\"'](?P<v>[^\s\"'\\]{8,256})\\?[\"']"
        ),
    ),
    (
        # A `.env`-style line: UNQUOTED value (the quoted rule above misses it).
        # Line start is a real newline or, inside a JSON-encoded tool result, a
        # literal `\n`.
        "env-secret-assignment",
        re.compile(
            r"(?im)(?:^|(?<=\\n))[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:TOKEN|SECRET|"
            r"PASSWORD|PASSWD|PWD|API_?KEY|APIKEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Z0-9_]*"
            r"[ \t]*=[ \t]*(?P<v>[^\s\"'#\\]{8,256})"
        ),
    ),
    ("telegram-bot-token", re.compile(r"\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b")),
)

# A value that is obviously not a real credential. Kept narrow: a false negative
# here is a missed secret, so only unmistakable placeholders are skipped.
_PLACEHOLDER = re.compile(
    r"(?i)^(?:x{4,}|\*{3,}|<[^>]*>|\$\{.*\}|\{\{.*\}\})$|example|changeme|placeholder|"
    r"your[_-]|dummy|redacted|process\.env|os\.environ|getenv"
)


@dataclass(frozen=True, slots=True)
class Hit:
    rule: str
    fingerprint: str
    start: int
    end: int


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()[:12]


def _entropy(s: str) -> float:
    if not s:
        return 0.0
    counts: dict[str, int] = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(s)
    return -sum(c / n * math.log2(c / n) for c in counts.values())


def scan(text: str) -> list[Hit]:
    """Every secret-shaped value in `text`, non-overlapping, in order."""
    if not text:
        return []
    hits: list[Hit] = []
    taken: list[tuple[int, int]] = []
    for rule, rx in _RULES:
        for m in rx.finditer(text):
            if "v" in rx.groupindex and m.group("v") is not None:
                s, e = m.span("v")
            else:
                s, e = m.span()
            value = text[s:e]
            if value.startswith(_MARKER) or _PLACEHOLDER.search(value):
                continue
            if rule.endswith("-secret-assignment") and _entropy(value) < 3.0:
                continue
            if any(ts < e and s < te for ts, te in taken):
                continue
            taken.append((s, e))
            hits.append(Hit(rule, fingerprint(value), s, e))
    hits.sort(key=lambda h: h.start)
    return hits


def marker(hit: Hit) -> str:
    return f"{_MARKER}{hit.rule} fp={hit.fingerprint}]"


def redact_text(text: str) -> tuple[str, list[Hit]]:
    """(redacted text, hits). Offsets in hits refer to the ORIGINAL text."""
    if not isinstance(text, str) or not text:
        return text, []
    hits = scan(text)
    out: list[str] = []
    pos = 0
    for h in hits:
        out.append(text[pos : h.start])
        # Keep the value's line breaks, so every line number after a multi-line
        # secret (a private-key block) still points at the same code.
        out.append(marker(h) + "\n" * text.count("\n", h.start, h.end))
        pos = h.end
    out.append(text[pos:])
    # The log-redaction shapes too (bearer headers, OAuth fields, data URIs), so a
    # security turn is never weaker than the log stream.
    return _log_redact("".join(out)), hits


def redact_obj(obj: Any) -> tuple[Any, list[Hit]]:
    """Recursively redact every string leaf (keys are left intact)."""
    hits: list[Hit] = []

    def walk(o: Any) -> Any:
        if isinstance(o, str):
            red, h = redact_text(o)
            hits.extend(h)
            return red
        if isinstance(o, dict):
            return {k: walk(v) for k, v in o.items()}
        if isinstance(o, list):
            return [walk(v) for v in o]
        if isinstance(o, tuple):
            return tuple(walk(v) for v in o)
        return o

    return walk(obj), hits


def line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1
