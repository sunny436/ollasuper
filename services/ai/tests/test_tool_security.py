from __future__ import annotations

import json
import logging
from pathlib import Path

import httpx
import pytest

from app.clients.ollagraph import OllagraphAdapter
from app.config import Settings
from app.logging import RedactFilter
from app.models.tools import ToolDefinition
from app.tools.discovery import discover_from_spec
from app.tools.errors import ToolError
from app.tools.registry import ToolRegistry

KEY = "osk_supersecret_key_0987654321"
SPEC = json.loads(
    (Path(__file__).parent / "fakes" / "ollagraph_openapi.json").read_text()
)


def test_key_is_in_secrets_redaction_registry():
    s = Settings(ollagraph_api_key=KEY, ollagraph_base_url="https://x")
    assert KEY in s.secrets()


def test_redact_filter_scrubs_the_key():
    f = RedactFilter((KEY,))
    rec = logging.LogRecord(
        "n", logging.INFO, __file__, 1, f"calling with {KEY}", None, None
    )
    f.filter(rec)
    assert KEY not in rec.msg
    assert "***" in rec.msg


def test_registry_serialization_never_contains_credentials():
    reg = ToolRegistry()
    r = discover_from_spec(SPEC, default_timeout=25.0)
    reg.replace_all(r.definitions, r.components, r.report)
    dumped = json.dumps([t.model_dump() for t in reg.list()])
    assert KEY not in dumped
    # No auth HEADER material leaks. (`required_auth: "BearerAuth"` is the
    # scheme NAME — intended metadata — not a credential, so it is allowed.)
    assert "authorization" not in dumped.lower()
    assert "osk_" not in dumped.lower()


async def test_provider_error_log_excludes_credentials(caplog):
    def handler(req):
        return httpx.Response(500, json={"e": 1})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    adapter = OllagraphAdapter(
        Settings(ollagraph_api_key=KEY, ollagraph_base_url="https://api.ollagraph.test"),
        client,
    )
    tool = ToolDefinition(tool_id="scrape", name="S", path="/v1/scrape", method="post")
    try:
        with caplog.at_level(logging.WARNING):
            with pytest.raises(ToolError):
                await adapter.call_tool(tool, {"url": "https://x.com"})
        # The provider error WAS logged, but only with safe fields.
        blob = json.dumps([r.__dict__ for r in caplog.records], default=str)
        assert "tool.provider_error" in blob
        assert KEY not in blob
        assert "authorization" not in blob.lower()
    finally:
        await client.aclose()
