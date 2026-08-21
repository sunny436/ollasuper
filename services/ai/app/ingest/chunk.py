"""Structure-aware, token-sized chunking with provenance.

Token-based sizing (via tiktoken through langchain-text-splitters) guarantees no
chunk overflows the embedding context regardless of language. Markdown recovers
its heading path into `section`; everything else size-splits each NormalizedDoc,
carrying page/section/source metadata into every chunk. Bounded by
ai_ingest_max_chars and ai_ingest_max_chunks.
"""

from __future__ import annotations

from langchain_text_splitters import (
    MarkdownHeaderTextSplitter,
    RecursiveCharacterTextSplitter,
)

from app.config import Settings
from app.ingest.types import Chunk, FileType, NormalizedDoc

_MD_HEADERS = [("#", "h1"), ("##", "h2"), ("###", "h3")]


def _size_splitter(settings: Settings) -> RecursiveCharacterTextSplitter:
    return RecursiveCharacterTextSplitter.from_tiktoken_encoder(
        encoding_name="cl100k_base",
        chunk_size=settings.ai_ingest_chunk_tokens,
        chunk_overlap=settings.ai_ingest_chunk_overlap,
    )


def _markdown_sectioned(docs: list[NormalizedDoc]) -> list[NormalizedDoc]:
    md = MarkdownHeaderTextSplitter(headers_to_split_on=_MD_HEADERS)
    out: list[NormalizedDoc] = []
    for doc in docs:
        for piece in md.split_text(doc.text):
            hpath = " > ".join(v for v in piece.metadata.values() if v)
            out.append(
                NormalizedDoc(
                    text=piece.page_content,
                    page=doc.page,
                    section=hpath or doc.section,
                    metadata=dict(doc.metadata),
                )
            )
    return out or docs


def chunk_docs_bounded(
    docs: list[NormalizedDoc], file_type: FileType, settings: Settings
) -> tuple[list[Chunk], bool]:
    """Like chunk_docs, but also reports whether the char/chunk cap truncated the
    document. `truncated` lets the pipeline tell the user the truth ("processed
    the first N chunks") instead of silently dropping the tail."""
    if file_type == "markdown":
        docs = _markdown_sectioned(docs)

    splitter = _size_splitter(settings)
    chunks: list[Chunk] = []
    total_chars = 0
    idx = 0
    for doc in docs:
        if not doc.text.strip():
            continue
        for piece in splitter.split_text(doc.text):
            if (
                total_chars >= settings.ai_ingest_max_chars
                or len(chunks) >= settings.ai_ingest_max_chunks
            ):
                return chunks, True
            total_chars += len(piece)
            meta = dict(doc.metadata)
            meta["page"] = doc.page
            meta["section"] = doc.section
            chunks.append(
                Chunk(
                    chunk_index=idx,
                    content=piece,
                    token_count=None,
                    page=doc.page,
                    section=doc.section,
                    source_metadata=meta,
                )
            )
            idx += 1
    return chunks, False


def chunk_docs(
    docs: list[NormalizedDoc], file_type: FileType, settings: Settings
) -> list[Chunk]:
    return chunk_docs_bounded(docs, file_type, settings)[0]
