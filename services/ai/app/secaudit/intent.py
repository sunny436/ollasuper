"""What kind of security turn is this? Built ON the router's security intent.

The router decides "security query → complex model". This refines it for the
runtime: an AUDIT (bind the audit tools, append the validated report) vs a plain
security question ("what is SSRF" — deep model, no repository work), and whether
the user explicitly asked for a FIX (the only case in which any write is bound).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.routing import security_intent

_C = re.IGNORECASE

# Work performed ON something: an action verb, or an explicit repository target.
# Deliberately NOT "code/app/endpoint": "is this endpoint exploitable?" is a deep
# question, not a repository audit with a coverage report.
_AUDIT = re.compile(
    r"\b(?:audit|scan|review|assess|check|test|find|look\s+for|hunt|analy[sz]e|inspect|"
    r"triage|validate|verify|investigate|examine|pentest|threat[\s-]?model|fix|patch|"
    r"remediate|harden)\w*|"
    r"\b(?:repo|repository|codebase|pull\s+request|diff|commit|branch)\b|github\.com/",
    _C,
)
_FIX = re.compile(
    # Whole words: "fixture", "patchwork" and "hardened" are not fix requests.
    r"\b(?:fix(?:es|ed|ing)?|patch(?:es|ed|ing)?|remediat(?:e|es|ed|ion|ing)|"
    r"harden(?:ing)?|apply\s+(?:the\s+|a\s+)?(?:fix|patch))\b",
    _C,
)
_DIFF = re.compile(
    r"\b(?:pr|pull\s+request|diff|commit\s+range|compare|between\s+\S+\s+and\s+\S+)\b|"
    r"#\d+|\.\.\.?[\w./-]+",
    _C,
)


@dataclass(frozen=True, slots=True)
class SecIntent:
    security: bool = False
    audit: bool = False
    fix: bool = False
    diff: bool = False


NONE = SecIntent()


def detect(text: str | None) -> SecIntent:
    text = text or ""
    if not security_intent(text):
        return NONE
    audit = bool(_AUDIT.search(text))
    return SecIntent(
        security=True,
        audit=audit,
        fix=audit and bool(_FIX.search(text)),
        diff=audit and bool(_DIFF.search(text)),
    )
