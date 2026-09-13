"""Curate the everyday connector set — but only what a live probe confirms.

THE THREE LAYERS STAY SEPARATE, which is the whole point:

    discovered   `mcp_servers` — 31,538 rows mirrored from the public registry.
                 Says what EXISTS. Executable by nobody.
    verified     this script's probe — an MCP `initialize`, or a 401 challenge,
                 against the real endpoint. Says what WORKS.
    curated      `mcp_curated_servers` — the rows written below. Says what THIS
                 DEPLOYMENT will dial. The only layer that is executable.

A registry entry never becomes executable on its own. Nothing here is curated
without a probe result, because a dead or wrong endpoint in an allowlist is a
security defect rather than a cosmetic one.

`auth_kind` COMES FROM THE PROBE, NOT FROM THE REGISTRY. `registry/parse.py`
deliberately refuses to infer OAuth — the registry publishes no auth-scheme
field — so the honest source is what the server actually answered: a completed
handshake means `none`, a 401 challenge means `oauth`.

`trusted` IS FALSE ON EVERY ROW, without exception. Curating a server makes it
connectable; it must never make the server's own `readOnlyHint` credible.
Setting it true would let a third party disarm the approval gate for its own
tools.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from qa.verify_candidates import _probe_one

# name -> (slug, display name, category). Curated by hand because the display
# layer is product copy: the registry's own titles are inconsistent and
# sometimes absent, and a catalogue is read by people.
CATALOGUE: dict[str, tuple[str, str, str]] = {
    # ---- developer ------------------------------------------------------
    "io.github.github/github-mcp-server": ("github", "GitHub", "developer"),
    "com.gitlab/mcp": ("gitlab", "GitLab", "developer"),
    "com.circleci/mcp": ("circleci", "CircleCI", "developer"),
    "com.vercel/vercel-mcp": ("vercel", "Vercel", "developer"),
    "com.cloudflare.mcp/mcp": ("cloudflare", "Cloudflare Docs", "developer"),
    "com.supabase/mcp": ("supabase", "Supabase", "developer"),
    "io.github.upstash/context7": ("context7", "Context7", "developer"),
    "com.microsoft/microsoft-learn-mcp": ("ms-learn", "Microsoft Learn", "developer"),
    "com.mux/mcp": ("mux", "Mux", "developer"),
    # ---- project & issue tracking ---------------------------------------
    "com.atlassian/atlassian-mcp-server": (
        "atlassian",
        "Jira & Confluence",
        "productivity",
    ),
    "app.linear/linear": ("linear", "Linear", "productivity"),
    "com.monday/monday.com": ("monday", "monday.com", "productivity"),
    "net.todoist/mcp": ("todoist", "Todoist", "productivity"),
    "com.teamwork/mcp": ("teamwork", "Teamwork", "productivity"),
    # ---- documents & knowledge ------------------------------------------
    "com.notion/mcp": ("notion", "Notion", "documents"),
    "com.airtable/mcp": ("airtable", "Airtable", "documents"),
    "com.egnyte/mcp-server": ("egnyte", "Egnyte", "documents"),
    "co.huggingface/hf-mcp-server": ("huggingface", "Hugging Face", "research"),
    # ---- design & content -----------------------------------------------
    "com.figma.mcp/mcp": ("figma", "Figma", "documents"),
    "io.github.miroapp/mcp-server": ("miro", "Miro", "documents"),
    "com.webflow/mcp": ("webflow", "Webflow", "business"),
    "com.wix/mcp": ("wix", "Wix", "business"),
    "com.jotform/mcp": ("jotform", "JotForm", "business"),
    "io.elevenlabs/mcp": ("elevenlabs", "ElevenLabs", "business"),
    # ---- payments & finance ---------------------------------------------
    "com.stripe/mcp": ("stripe", "Stripe", "finance"),
    "com.paypal.mcp/mcp": ("paypal", "PayPal", "finance"),
    # ---- meetings & comms -----------------------------------------------
    "io.github.zoom/zoom-meetings": ("zoom-meetings", "Zoom Meetings", "communication"),
    "io.github.zoom/zoom-team-chat": ("zoom-chat", "Zoom Team Chat", "communication"),
    "io.github.zoom/zoom-tasks": ("zoom-tasks", "Zoom Tasks", "communication"),
    "io.github.zoom/zoom-workspace": (
        "zoom-workspace",
        "Zoom Workspace",
        "communication",
    ),
    "ai.fireflies/fireflies": ("fireflies", "Fireflies", "communication"),
    # ---- observability & ops --------------------------------------------
    "io.github.grafana/mcp-grafana": ("grafana", "Grafana", "developer"),
    "com.newrelic/mcp-server": ("newrelic", "New Relic", "developer"),
    "io.honeycomb/mcp": ("honeycomb", "Honeycomb", "developer"),
    "io.github.PostHog/mcp": ("posthog", "PostHog", "business"),
    "com.amplitude/mcp-server": ("amplitude", "Amplitude", "business"),
    "io.github.algolia/algolia-productivity": ("algolia", "Algolia", "developer"),
    # ---- automation & web -----------------------------------------------
    "com.zapier/mcp": ("zapier", "Zapier", "productivity"),
    "com.make/mcp-server": ("make", "Make", "productivity"),
    "com.apify/apify-mcp-server": ("apify", "Apify", "browser"),
    "ai.exa/exa": ("exa", "Exa Search", "research"),
    "io.globalping/mcp": ("globalping", "Globalping", "developer"),
    "com.bitly/mcp": ("bitly", "Bitly", "business"),
    "ai.klavis/strata": ("klavis", "Klavis Strata", "productivity"),
    "to.unified/core": ("unified", "Unified.to", "business"),
}


async def main() -> None:
    rows = json.load(sys.stdin)  # [{name, url, transport}, ...]
    wanted = [r for r in rows if r["name"] in CATALOGUE]

    sem = asyncio.Semaphore(6)

    async def run(c: dict) -> dict:
        async with sem:
            return await _probe_one(c["name"], c["url"], c.get("transport", ""))

    verdicts = await asyncio.gather(*(run(c) for c in wanted))

    out: list[dict[str, Any]] = []
    for v in verdicts:
        if v["verdict"] not in ("open", "auth"):
            continue  # NOT curated. A dead endpoint in an allowlist is a defect.
        slug, display, category = CATALOGUE[v["name"]]
        out.append(
            {
                "server_name": v["name"],
                "slug": slug,
                "display_name": display,
                "category": category,
                "endpoint_url": v["url"],
                "transport": v["transport"] or "streamable-http",
                # The PROBE's answer, not the registry's guess.
                "auth_kind": "none" if v["verdict"] == "open" else "oauth",
                "verdict": v["verdict"],
                "tools": v["tools"],
                "detail": v["detail"],
            }
        )
    print(json.dumps(out, indent=None))


if __name__ == "__main__":
    asyncio.run(main())
