"""Shared types for the ingestion pipeline.

Dataclasses, not Pydantic: this is internal hot-path data (potentially thousands
of chunks per file), and Pydantic validation buys nothing here — the HTTP edge
already validated the request. Mirrors the TypedDict-in-graph choice in
app/agent/graph.py.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

# Canonical types the registry dispatches on. `image` is handled specially (OCR
# is async network I/O, not a CPU parser) and is deliberately NOT a registry key.
FileType = Literal[
    "pdf",
    "docx",
    "pptx",
    "xlsx",
    "csv",
    "json",
    "html",
    "markdown",
    "text",
    "image",
]


class IngestError(Exception):
    """A parse/guard failure. Surfaces as a `failed` file, never a 500.

    `code` is the STABLE failure code Convex keys on (libraryProcessing
    FAILURE_CODES) — whether it is retried automatically, what the UI says.
    Raise sites name it; one that does not gets the code its message maps to.
    """

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code or failure_code_for(message)


# Message -> code for the raise sites that predate codes. Mirrors
# libraryProcessing.codeFromMessage on the Convex side.
_MESSAGE_CODES: tuple[tuple[str, str], ...] = (
    ("Embedding rate limit exceeded", "EMBED_RATE_LIMIT"),
    ("Embedding provider failed", "EMBED_PROVIDER"),
    ("Knowledge database write failed", "KNOWLEDGE_DB"),
    ("Parsing timed out", "PARSE_TIMEOUT"),
    ("OCR timed out", "OCR_TIMEOUT"),
    ("The image took too long to read", "PARSE_TIMEOUT"),
    ("The stored file failed its integrity check", "INTEGRITY"),
    ("File too large", "TOO_LARGE"),
    ("no parser for", "UNSUPPORTED"),
)


def failure_code_for(message: str) -> str:
    for prefix, code in _MESSAGE_CODES:
        if message.startswith(prefix):
            return code
    if "sandbox is unavailable" in message or "sandbox is below" in message:
        return "SANDBOX_UNAVAILABLE"
    return "PARSE_FAILED"


@dataclass
class NormalizedDoc:
    """One structure-preserving unit from a parser (a PDF page, an XLSX sheet, a
    heading section...). Provenance travels into every chunk derived from it."""

    text: str
    page: int | None = None
    section: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class Chunk:
    chunk_index: int
    content: str
    token_count: int | None
    page: int | None
    section: str | None
    source_metadata: dict[str, Any]
    embedding: Sequence[float] | None = None


class Parser(Protocol):
    """CPU-bound, synchronous; the orchestrator runs it in a thread under a
    timeout. Returns normalized units in document order."""

    def __call__(self, raw: bytes, *, name: str) -> list[NormalizedDoc]: ...
