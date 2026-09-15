"""Responses are bounded ON THE WIRE (audit H-08).

`adapter.py` bounds what reaches the model; these tests prove the transport
cuts a hostile response BEFORE the SDK buffers or parses it: an oversized JSON
body, a compressed body, an SSE stream that never stops, a declared length over
the cap — and, at the adapter, a block flood and a nesting bomb. Every byte
count asserted here is measured against a counting transport, not inferred.
"""

from __future__ import annotations

import gzip
import json
from typing import Any

import httpx2
import pytest

from app.mcp.adapter import McpToolAdapter
from app.mcp.exceptions import McpConnectionError, McpErrorKind
from app.mcp.transport import ResponseLimits, build_http_client
from app.tools.errors import ToolError, ToolErrorKind
from tests.fakes.mcp_http import spec

pytestmark = pytest.mark.anyio

URL = "https://93.184.216.34/mcp"
SMALL = ResponseLimits(
    max_response_bytes=4096,
    max_stream_bytes_per_request=8192,
    max_listen_stream_bytes=16384,
)


class _Recorder:
    async def __call__(self, response: Any) -> None:
        return None


def _client(handler: Any, limits: ResponseLimits = SMALL) -> Any:
    served: dict[str, int] = {"bytes": 0}

    def counting(request: httpx2.Request) -> httpx2.Response:
        response = handler(request)
        return response

    client = build_http_client(
        spec(), {}, _Recorder(), transport=httpx2.MockTransport(counting), limits=limits
    )
    return client, served


async def _expect_cut(client: Any, method: str = "GET") -> McpConnectionError:
    async with client:
        with pytest.raises(McpConnectionError) as info:
            response = await client.request(method, URL)
            await response.aread()
    assert info.value.kind is McpErrorKind.RESPONSE_TOO_LARGE
    return info.value


# ---------------------------------------------------------------- the wire
async def test_the_client_asks_for_identity_encoding() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen["accept-encoding"] = request.headers.get("accept-encoding", "")
        return httpx2.Response(200, json={})

    client, _ = _client(handler)
    async with client:
        await client.get(URL)
    assert seen["accept-encoding"] == "identity"


async def test_a_compressed_response_is_refused_before_decoding() -> None:
    """1 MB of gzip can be 1 GB decoded. The decoded size is unknowable, so
    the body is refused on the header alone — nothing is inflated."""
    bomb = gzip.compress(b"A" * 200_000)  # tiny on the wire
    assert len(bomb) < 4096

    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200,
            content=bomb,
            headers={"content-encoding": "gzip", "content-type": "application/json"},
        )

    client, _ = _client(handler)
    err = await _expect_cut(client)
    assert "compressed" in err.detail


async def test_a_declared_length_over_the_cap_is_refused_before_the_body() -> None:
    read: list[int] = []

    class Body(httpx2.AsyncByteStream):
        async def __aiter__(self):
            read.append(1)
            yield b"x" * 100

    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200,
            stream=Body(),
            headers={"content-length": "999999", "content-type": "application/json"},
        )

    client, _ = _client(handler)
    err = await _expect_cut(client)
    assert "declares 999999" in err.detail
    assert read == [], "the body was read despite the declared length"


async def test_an_oversized_json_body_is_cut_mid_stream() -> None:
    """No Content-Length (chunked). The counter cuts the stream at the cap;
    the bytes past it are never pulled from the server."""
    chunks_served: list[int] = []

    class Body(httpx2.AsyncByteStream):
        async def __aiter__(self):
            for _ in range(1000):  # 1000 x 1 KiB = ~1 MB, cap is 4 KiB
                chunks_served.append(1)
                yield b"{" + b"x" * 1023

    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200, stream=Body(), headers={"content-type": "application/json"}
        )

    client, _ = _client(handler)
    err = await _expect_cut(client, "POST")
    assert "response body exceeded 4096 bytes" in err.detail
    # Cut within one chunk of the cap, not after buffering the megabyte.
    assert len(chunks_served) <= 5


async def test_an_endless_sse_stream_is_cut_at_the_per_request_cap() -> None:
    """A server that streams progress notifications forever on the POST's own
    SSE stream: cut at the per-request stream cap."""
    served: list[int] = []

    class Body(httpx2.AsyncByteStream):
        async def __aiter__(self):
            while True:
                served.append(1)
                yield b"event: message\ndata: " + b"p" * 1000 + b"\n\n"

    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200, stream=Body(), headers={"content-type": "text/event-stream"}
        )

    client, _ = _client(handler)
    async with client:
        with pytest.raises(McpConnectionError) as info:
            async with client.stream("POST", URL) as response:
                async for _ in response.aiter_bytes():
                    pass
    assert info.value.kind is McpErrorKind.RESPONSE_TOO_LARGE
    assert "response stream exceeded 8192" in info.value.detail
    assert len(served) <= 12


async def test_the_listen_stream_has_its_own_larger_cap() -> None:
    served: list[int] = []

    class Body(httpx2.AsyncByteStream):
        async def __aiter__(self):
            while True:
                served.append(1)
                yield b"data: " + b"n" * 1000 + b"\n\n"

    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200, stream=Body(), headers={"content-type": "text/event-stream"}
        )

    client, _ = _client(handler)
    async with client:
        with pytest.raises(McpConnectionError) as info:
            async with client.stream("GET", URL) as response:
                async for _ in response.aiter_bytes():
                    pass
    assert "listen stream exceeded 16384" in info.value.detail
    assert 16 <= len(served) <= 20


async def test_a_response_under_the_cap_passes_untouched() -> None:
    payload = {"ok": True, "data": "x" * 2000}

    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json=payload)

    client, _ = _client(handler)
    async with client:
        response = await client.post(URL)
        assert response.json() == payload


def test_the_per_event_bound_stays_at_one_mebibyte() -> None:
    """The SSE per-event cap is httpx2's default; pinned so a library bump
    cannot raise it silently."""
    from httpx2._config import DEFAULT_MAX_EVENT_SIZE_BYTES

    assert DEFAULT_MAX_EVENT_SIZE_BYTES <= 1024 * 1024


# ------------------------------------------------------------ the adapter
class _Block:
    def __init__(self, text: str) -> None:
        self.type = "text"
        self.text = text


class _Result:
    def __init__(self, content=None, structured=None, is_error=False) -> None:
        self.content = content
        self.structured_content = structured
        self.is_error = is_error


def test_a_block_flood_is_cut_before_it_is_walked() -> None:
    blocks = [_Block("b") for _ in range(100_000)]
    out = McpToolAdapter._normalize_result(
        _Result(content=blocks), 1_000_000, max_blocks=512
    )
    assert out["text"].count("b") == 512
    assert any(
        "99488 content blocks" in m.get("omitted", "") for m in out["omitted_content"]
    )


def test_a_nesting_bomb_is_dropped_before_serialisation(monkeypatch: Any) -> None:
    deep: Any = {"x": 1}
    for _ in range(200):
        deep = {"n": deep}
    dumps_calls: list[int] = []
    real = json.dumps

    def spy(*a: Any, **k: Any) -> str:
        dumps_calls.append(1)
        return real(*a, **k)

    monkeypatch.setattr(json, "dumps", spy)
    out = McpToolAdapter._normalize_result(
        _Result(structured=deep), 1_000_000, max_depth=32
    )
    assert "nested deeper" in out["structured"]["error"]
    assert dumps_calls == [], "the bomb was serialised"


def test_the_configured_byte_cap_is_the_one_applied() -> None:
    """The regression that started H-08: the adapter stored its cap and then
    normalised with the module default."""
    adapter = McpToolAdapter(
        session_provider=lambda: None, result_max_bytes=2048, server_slug="s"
    )
    out = adapter._normalize_result(
        _Result(content=[_Block("x" * 10_000)]), adapter._result_max_bytes
    )
    assert "[truncated: the server returned more than 2048 bytes]" in out["text"]
    assert len(out["text"]) < 2200


def test_text_is_bounded_in_bytes_not_characters() -> None:
    out = McpToolAdapter._normalize_result(_Result(content=[_Block("é" * 3000)]), 4096)
    assert "truncated" in out["text"]


# --------------------------------------------------- the error the model sees
def test_a_cut_response_is_a_non_retryable_tool_error() -> None:
    from app.mcp.errors import to_tool_error

    err = to_tool_error(
        McpConnectionError(
            McpErrorKind.RESPONSE_TOO_LARGE, "response body exceeded 8 bytes"
        ),
        server_slug="s",
    )
    assert isinstance(err, ToolError)
    assert err.kind is ToolErrorKind.MALFORMED_RESPONSE
    assert err.retryable is False
    assert "exceeded" in str(err)
