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
    "xlsx",
    "csv",
    "json",
    "html",
    "markdown",
    "text",
    "image",
]


class IngestError(Exception):
    """A parse/guard failure. Surfaces as a `failed` file, never a 500."""


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
