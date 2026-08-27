"""The `enqueue_seo_audit` reserved built-in tool spec (Phase 5: durable SEO runs).

Pure data + the tool name, so both `executor.py` (the handler) and `runner.py` (which
binds it when `ai_seo_runs_enabled`) import it with no cycle — mirroring the
generate_file / RAG / memory built-in pattern. Calling it hands a LARGE, site-wide audit
to the durable background run subsystem (never for a single-page check, which the agent
answers inline in the turn).
"""

from __future__ import annotations

ENQUEUE_SEO_AUDIT_TOOL_NAME = "enqueue_seo_audit"

ENQUEUE_SEO_AUDIT_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": ENQUEUE_SEO_AUDIT_TOOL_NAME,
        "description": (
            "Start a LARGE, site-wide SEO audit that runs in the BACKGROUND and "
            "cannot finish inside this chat turn. Use this ONLY when the user asks to "
            "audit a whole site / many pages (e.g. 'audit my entire site', 'crawl "
            "example.com and check every page', 'full SEO audit of the domain'). Do "
            "NOT use it for a single page or a quick check — answer those inline. It "
            "returns immediately with a tracking handle; the live progress and the "
            "final report appear in the chat on their own as the audit runs. Tell the "
            "user the audit has started."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "description": (
                        "The site or root URL to audit (e.g. https://example.com)."
                    ),
                },
                "scope": {
                    "type": "string",
                    "enum": ["site", "section"],
                    "description": (
                        "Audit the whole site, or a section under the target URL."
                    ),
                },
                "max_urls": {
                    "type": "integer",
                    "description": "Optional cap on how many URLs to crawl.",
                    "minimum": 1,
                },
            },
            "required": ["target"],
        },
    },
}
