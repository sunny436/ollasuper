"""Security intent always reaches the complex model; everything else is untouched.

The router is the ONE place model selection happens, so the security floor lives
there (not in a second router). These cases pin both directions: every security
query is HEAVY and final (no definitional or `fast` demotion), and the near
misses — a blog ABOUT XSS, a security deposit — keep their normal decision.
"""

from __future__ import annotations

import pytest

from app.agent import health
from app.routing import (
    HEAVY,
    Candidate,
    RouterConfig,
    Signals,
    classify,
    security_intent,
    select,
)

PROFILES = (
    '{"gemini-3.7-flash-high": {"ttft_s": 2.97, "reasoning_tier": 0},'
    ' "deepseek-v4-flash":     {"ttft_s": 3.68, "reasoning_tier": 1},'
    ' "gemini-3.8-pro":        {"ttft_s": 5.23, "reasoning_tier": 2}}'
)
ALL = [
    Candidate("gemini-3.7-flash-high"),
    Candidate("deepseek-v4-flash"),
    Candidate("gemini-3.8-pro"),
]


@pytest.fixture
def cfg() -> RouterConfig:
    health.reset()
    return RouterConfig.from_settings(True, PROFILES)


def _route(cfg, text, speed="balanced"):
    return select(
        cfg=cfg,
        candidates=ALL,
        fallback="gemini-3.7-flash-high",
        signals=Signals(text=text, response_speed=speed),
    )


SECURITY = [
    "run a security audit of the fixture repository",
    "what is SSRF?",
    "what is XSS",
    "review PR #42 for vulnerabilities",
    "is this endpoint exploitable?",
    "check sunny436/ollasuper on GitHub for hardcoded secrets",
    "threat model our MCP connector flow",
    "find IDOR or BOLA issues in the chat authz code",
    "fix the SQL injection in users.py",
    "does CVE-2024-3094 affect us",
    "map the attack surface of the upload parser",
    "OWASP top 10 review of the Next.js app",
    "look for prompt injection paths that reach tool execution",
    "is my login flow secure",
    "scan the repo for leaked api keys",
    "privilege escalation via the scheduler?",
    "security review of the websocket proxy",
    "penetration test plan for staging",
    # a long paste whose intent is only at the end
    "def handler(req):\n    q = req.args['id']\n"
    + ("    pass\n" * 200)
    + "\nis this vulnerable?",
]

NOT_SECURITY = [
    "hi",
    "write a blog post about common XSS vulnerabilities",
    "draft a newsletter on OWASP trends for our customers",
    "translate this article about SQL injection into Hindi",
    "what is the security deposit for a 2BHK in Pune",
    "what is a social security number format",
    "exploit this marketing opportunity before Diwali",
    "write a Python function to parse a CSV file",
    "summarize this meeting",
    "compare Postgres and MongoDB for analytics",
    "do a deep SEO audit of https://example.com",
    "what's the weather in Delhi",
    "create landing page copy for a meditation app",
]


@pytest.mark.parametrize("q", SECURITY)
def test_security_queries_always_reach_the_reasoner(cfg, q):
    assert security_intent(q), q
    c = classify(Signals(text=q))
    assert (c.work, c.reasoning) == ("security", HEAVY)
    for speed in ("fast", "balanced", "thorough"):
        d = _route(cfg, q, speed)
        assert d.model == "gemini-3.8-pro", (q, speed, d)
        assert d.work == "security" and d.floor == HEAVY


@pytest.mark.parametrize("q", NOT_SECURITY)
def test_normal_queries_are_untouched(cfg, q):
    assert not security_intent(q), q
    assert classify(Signals(text=q)).work != "security"


def test_an_unhealthy_reasoner_degrades_visibly_never_silently(cfg, monkeypatch):
    monkeypatch.setattr(
        health, "is_exhausted", lambda m: m == "gemini-3.8-pro", raising=True
    )
    d = _route(cfg, "security audit of the fixture repo")
    assert d.model == "deepseek-v4-flash"
    assert d.work == "security" and "floor_unmet" in d.reason


def test_normal_decisions_are_byte_identical_for_non_security_prompts(cfg):
    # The security check returns before the taxonomy ONLY on a match, so a normal
    # turn's reason string carries no new tag when its floor is met.
    d = _route(cfg, "hi")
    assert d.model == "gemini-3.7-flash-high" and "floor_unmet" not in d.reason
