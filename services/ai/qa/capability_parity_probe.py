"""Live check that a routed model can USE the capability layer we give it.

    cd services/ai
    uv run python -m qa.capability_parity_probe gemini-3.7-flash-high,deepseek-v4-flash

Unit tests prove every model is GIVEN the same layer; only the provider can say
whether it accepts and uses it. Per model, through the app's own client
(`build_llm(...).bind_tools`), exactly as the graph calls it:

  tools     a real reserved spec beside a decoy, STREAMING client — the right tool
            chosen by purpose
  twin      the same on the NON-streaming twin the graph falls back to
  parallel  three tool calls in one streamed response
  ceiling   max_tokens 16,384 (responseSpeed="thorough") accepted
  schema    a tool carrying the constructs MCP servers emit, after the same
            `_portable_schema` pass bound specs get — accepted

It runs against the SHARED production key, so it is throttled and a model's
first 429 ends that model's run: probing must never itself push a production
model into (or deeper into) its usage limit. A 429 is reported as BLOCKED, never
as a pass or a fail.
"""

from __future__ import annotations

import asyncio
import sys
import time

import httpx
from langchain_core.messages import HumanMessage

from app.agent.executor import _portable_schema
from app.agent.filegen_tool import GENERATE_FILE_TOOL_SPEC
from app.agent.llm import build_llm
from app.config import get_settings

PAUSE_S = 2.0

WEATHER = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Current weather for one city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}
CONSTRUCTS = {
    "type": "object",
    "properties": {
        "kind": {"type": ["string", "null"]},
        "limit": {"oneOf": [{"type": "integer"}, {"type": "string"}]},
        "name": {"allOf": [{"type": "string"}, {"minLength": 1}]},
        "ref": {"$ref": "#/$defs/Name"},
        "tags": {"type": "array", "items": {"type": "string"}, "uniqueItems": True},
        "labels": {"type": "object", "propertyNames": {"pattern": "^[a-z]+$"}},
        "score": {"type": "number", "exclusiveMinimum": 0},
        "id": {"type": "string", "readOnly": True},
        "value": {"type": "string", "if": {"minLength": 1}, "then": {"maxLength": 9}},
    },
    "$defs": {"Name": {"type": "string"}},
}


class Blocked(Exception):
    """The provider refused for capacity — not a verdict on the model."""


def _is_limit(exc: BaseException) -> bool:
    text = str(exc).lower()
    return "429" in text or "usage limit" in text or "cooldown" in text


async def _call(fn):
    await asyncio.sleep(PAUSE_S)
    try:
        return await fn()
    except Exception as exc:  # noqa: BLE001 — classified below
        if _is_limit(exc):
            raise Blocked from exc
        return f"FAIL {type(exc).__name__}: {str(exc)[:70]}"


async def probe(s, model: str) -> dict[str, str]:
    def client(streaming: bool, max_tokens: int = 1500):
        return build_llm(
            s,
            model=model,
            streaming=streaming,
            max_tokens=max_tokens,
            base_url=s.ollima_base_url,
            api_key=s.ollima_api_key,
        )

    ask_file = [
        HumanMessage(
            "Create a downloadable CSV file with two rows of sample data. "
            "Call the appropriate tool now."
        )
    ]

    async def tools(streaming: bool):
        r = (
            await client(streaming)
            .bind_tools([WEATHER, GENERATE_FILE_TOOL_SPEC])
            .ainvoke(ask_file)
        )
        names = [c["name"] for c in r.tool_calls or []]
        return "ok" if "generate_file" in names else f"FAIL called {names or 'nothing'}"

    async def parallel():
        r = (
            await client(True)
            .bind_tools([WEATHER])
            .ainvoke(
                [
                    HumanMessage(
                        "Get the weather for Paris, Tokyo and Lima: call the tool "
                        "three times, in parallel, in this one response."
                    )
                ]
            )
        )
        n = len(r.tool_calls or [])
        return "ok" if n >= 3 else f"FAIL {n} calls"

    async def ceiling():
        await client(False, max_tokens=16_384).ainvoke([HumanMessage("Say ok.")])
        return "ok"

    async def schema():
        spec = {
            "type": "function",
            "function": {
                "name": "probe",
                "description": "Probe.",
                "parameters": _portable_schema(CONSTRUCTS),
            },
        }
        await (
            client(False, max_tokens=30)
            .bind_tools([spec])
            .ainvoke([HumanMessage("Say ok.")])
        )
        return "ok"

    checks = {
        "tools": lambda: tools(True),
        "twin": lambda: tools(False),
        "parallel": parallel,
        "ceiling": ceiling,
        "schema": schema,
    }
    out: dict[str, str] = {}
    for name, fn in checks.items():
        try:
            out[name] = await _call(fn)
        except Blocked:
            out[name] = "BLOCKED 429"
            for rest in list(checks)[len(out) :]:
                out[rest] = "not run"
            break
    return out


async def main() -> int:
    models = sys.argv[1].split(",") if len(sys.argv) > 1 else []
    if not models:
        print(__doc__)
        return 2
    s = get_settings()
    cols = ["tools", "twin", "parallel", "ceiling", "schema"]
    print(f"{'model':26} " + " ".join(f"{c:12}" for c in cols))
    failed = False
    for model in models:
        t0 = time.perf_counter()
        row = await probe(s, model)
        failed |= any(v.startswith("FAIL") for v in row.values())
        print(
            f"{model:26} "
            + " ".join(f"{row[c][:12]:12}" for c in cols)
            + f" {time.perf_counter() - t0:5.1f}s"
        )
        for c in cols:
            if row[c].startswith("FAIL") and len(row[c]) > 12:
                print(f"    {c}: {row[c]}")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except httpx.HTTPError as exc:
        print(f"transport: {exc}")
        sys.exit(1)
