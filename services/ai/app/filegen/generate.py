"""Generation orchestration: spec → render → validate → FileArtifact.

`render_and_validate` is the **picklable, module-level pool entrypoint** (a spec dict
in, `(bytes, mime, report)` out) — the executor runs it in the shared process pool for
binary/chart formats and inline for the trivial text formats. It reconstructs the
`FileSpec`, dispatches to the right renderer, and validates the bytes before returning.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.filegen import documents, images, presentations, spreadsheets
from app.filegen.mime import BINARY_FORMATS, mime_for, safe_filename
from app.filegen.spec import FileSpec, has_chart
from app.filegen.validate import validate_output


class FileGenError(RuntimeError):
    """A controlled generation/validation failure — surfaced to the model as a safe
    error, never a crash."""


@dataclass(slots=True)
class FileArtifact:
    filename: str
    mime: str
    format: str
    size: int
    data: bytes
    report: dict = field(default_factory=dict)


def _dispatch(spec: FileSpec) -> tuple[bytes, str]:
    fmt = spec.format
    if fmt == "pdf":
        return documents.render_pdf(spec)
    if fmt == "docx":
        return documents.render_docx(spec)
    if fmt == "txt":
        return documents.render_txt(spec)
    if fmt == "md":
        return documents.render_md(spec)
    if fmt == "html":
        return documents.render_html(spec)
    if fmt == "rtf":
        return documents.render_rtf(spec)
    if fmt == "xlsx":
        return spreadsheets.render_xlsx(spec)
    if fmt == "csv":
        return spreadsheets.render_delimited(spec, ",", "csv")
    if fmt == "tsv":
        return spreadsheets.render_delimited(spec, "\t", "tsv")
    if fmt == "json":
        return spreadsheets.render_json(spec)
    if fmt == "xml":
        return spreadsheets.render_xml(spec)
    if fmt == "yaml":
        return spreadsheets.render_yaml(spec)
    if fmt == "pptx":
        return presentations.render_pptx(spec)
    if fmt in ("png", "jpeg", "webp", "svg"):
        return images.render_image(spec)
    raise FileGenError(f"unsupported format: {fmt}")


def needs_pool(spec: FileSpec) -> bool:
    """Binary/C-extension renders + anything with a matplotlib chart run in the
    process pool (off the event loop, crash-isolated); trivial text renders inline."""
    return spec.format in BINARY_FORMATS or has_chart(spec)


def render_and_validate(spec_dict: dict) -> tuple[bytes, str, dict]:
    """PICKLABLE pool entrypoint. Raises on a hard render failure (→ the pool returns
    None → the caller surfaces a safe error); returns a report with ok=False for a
    controlled validation miss."""
    spec = FileSpec.model_validate(spec_dict)
    data, mime = _dispatch(spec)
    report = validate_output(spec.format, data)
    return data, mime, report


def artifact_filename(spec: FileSpec) -> str:
    return safe_filename(spec.filename or spec.title, spec.format)


def build_artifact(
    spec: FileSpec, data: bytes, mime: str, report: dict
) -> FileArtifact:
    return FileArtifact(
        filename=artifact_filename(spec),
        mime=mime or mime_for(spec.format),
        format=spec.format,
        size=len(data),
        data=data,
        report=report,
    )
