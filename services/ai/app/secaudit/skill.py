"""SECURITY_SKILL — the audit method, adapted from openai/codex-security.

Attribution: the scan methodology (auditor + focused investigator perspectives,
per-finding validation, attack-path analysis, severity calibration, coverage
honesty, diff scoping) is adapted from openai/codex-security, licensed under the
Apache License 2.0. The guidance text (skill_instructions.md) is a condensed
rewrite for OllaSuper's tools.
"""

from __future__ import annotations

from pathlib import Path

from app.skills.manifest import SkillManifest

_HERE = Path(__file__).parent

SECURITY_SKILL = SkillManifest(
    skill_id="security-audit",
    metadata={"category": "Coding"},
    name="Security Audit",
    version="1.0.0",
    purpose=(
        "evidence-backed security audits of a repository (an allowlisted local "
        "repository or a GitHub repository through your GitHub connection): threat "
        "model, vulnerability discovery, finding validation, attack paths, severity, "
        "and approved minimal fixes with a retest — read-only unless you ask for a fix"
    ),
    when_to_use=(
        "security audit/review/scan of code, a PR or a diff; finding vulnerabilities "
        "(IDOR/BOLA, injection, SSRF, XSS, auth bypass, secrets, supply chain); threat "
        "modelling; triaging or fixing a security finding"
    ),
    tags=frozenset(
        {
            "security",
            "vulnerability",
            "vulnerabilities",
            "owasp",
            "cwe",
            "cve",
            "pentest",
            "exploitable",
            "ssrf",
            "xss",
            "idor",
            "injection",
            "secrets",
        }
    ),
    methodology="Scope first, then evidence. Never guess, never claim code is secure.",
    instructions=(_HERE / "skill_instructions.md").read_text(encoding="utf-8"),
    constraints=(
        "Never claim the code is secure or that nothing is wrong beyond the scanned "
        "scope; never print a secret value; never modify anything without an explicit "
        "fix request and the user's approval."
    ),
)
