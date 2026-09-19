"""The `generate_file` reserved built-in tool spec (Phase: File Generation System).

Pure data + a spec-parse helper, so both `executor.py` (the handler) and `runner.py`
(binds it when the flag is on) import it with no cycle — mirroring the RAG/memory
built-in pattern. The model provides a STRUCTURED spec; deterministic Python renders
the binary (the model never emits file bytes).
"""

from __future__ import annotations

FILE_GEN_TOOL_NAME = "generate_file"

_CHART = {
    "type": "object",
    "description": (
        "A chart to render/embed. Flat shape: `type` + `labels` + `series[{name, "
        "values}]` (or `values` for one series). The Chart.js shape (`type`, `data: "
        "{labels, datasets:[{label, data}]}`) is accepted too. `doughnut` is the "
        "same as `donut`. Unsupported types (radar, bubble, …) are rejected, never "
        "substituted. Uploaded images/logos cannot be embedded."
    ),
    "properties": {
        "type": {
            "type": "string",
            "enum": [
                "bar",
                "line",
                "pie",
                "donut",
                "doughnut",
                "scatter",
                "area",
                "histogram",
            ],
        },
        "title": {"type": "string"},
        "x_label": {"type": "string"},
        "y_label": {"type": "string"},
        "labels": {
            "type": "array",
            "items": {"type": "string"},
            "description": "x-axis categories or pie slice labels.",
        },
        "series": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "values": {"type": "array", "items": {"type": "number"}},
                },
            },
        },
        "values": {
            "type": "array",
            "items": {"type": "number"},
            "description": "A single unnamed series (pie/histogram/simple bar).",
        },
    },
    "required": ["type"],
}
# A table cell is text OR a number. Declared explicitly because GEMINI REJECTS
# an array with no `items` — `{"type": "array", "items": {"type": "array"}}` came
# back `400 ...rows.items.items: missing field`, and since this spec is bound on
# every agentic turn, EVERY Gemini turn failed before producing a token (measured
# 2026-09-16, the day the router moved simple and complex work onto Gemini).
# OpenAI-compatible providers had been tolerating the omission silently.
#
# `anyOf` rather than `"type": "string"`: probed on the live gateway, all three
# routed models accept it, and it lets the model emit REAL numbers (deepseek sent
# `1.5` rather than `"$1.50"`), which the xlsx renderer keeps numeric so native
# charts still plot. Forcing strings would have fixed Gemini and broken charts.
_CELL = {"anyOf": [{"type": "string"}, {"type": "number"}]}
_ROWS = {"type": "array", "items": {"type": "array", "items": _CELL}}

_TABLE = {
    "type": "object",
    "properties": {
        "columns": {"type": "array", "items": {"type": "string"}},
        "rows": _ROWS,
    },
}

GENERATE_FILE_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": FILE_GEN_TOOL_NAME,
        "description": (
            "Generate a DOWNLOADABLE file for the user and attach it to the chat. "
            "Use this whenever the user asks for a document, spreadsheet, "
            "chart, image, or data export (e.g. 'give me a PDF', 'make an Excel file', "
            "'create a PowerPoint', 'export as CSV', 'draw a bar chart'). Provide the "
            "content as STRUCTURED data (never raw bytes). Choose the format the "
            "user asked for; put report/letter/article content in `sections`, tabular "
            "data in `sheets`, slides in `slides`, and a single chart/image in "
            "`chart`. "
            "For pdf/docx set `page_numbers: true` for 'Page X of Y' footers and "
            "`toc: true` for a table of contents built from the section headings. "
            "NOT supported: embedding an uploaded image or logo into a generated file "
            "(say so; leave a labelled placement zone instead)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "format": {
                    "type": "string",
                    "enum": [
                        "pdf",
                        "docx",
                        "txt",
                        "md",
                        "html",
                        "rtf",
                        "xlsx",
                        "csv",
                        "tsv",
                        "json",
                        "xml",
                        "yaml",
                        "pptx",
                        "png",
                        "jpeg",
                        "webp",
                        "svg",
                    ],
                    "description": "The output file format the user wants.",
                },
                "filename": {
                    "type": "string",
                    "description": "Optional base name (no extension needed).",
                },
                "title": {"type": "string"},
                "subtitle": {"type": "string"},
                "author": {"type": "string"},
                "sections": {
                    "type": "array",
                    "description": "Document/report body — one entry per section.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "heading": {"type": "string"},
                            "level": {"type": "integer", "minimum": 1, "maximum": 6},
                            "text": {
                                "type": "string",
                                "description": "Paragraphs separated by blank lines.",
                            },
                            "bullets": {"type": "array", "items": {"type": "string"}},
                            "ordered": {"type": "boolean"},
                            "table": _TABLE,
                            "chart": _CHART,
                            "caption": {"type": "string"},
                            "page_break_before": {"type": "boolean"},
                        },
                    },
                },
                "sheets": {
                    "type": "array",
                    "description": "Spreadsheet data — one entry per worksheet.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "columns": {"type": "array", "items": {"type": "string"}},
                            "rows": _ROWS,
                            "chart": _CHART,
                        },
                    },
                },
                "slides": {
                    "type": "array",
                    "description": "Presentation slides.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "subtitle": {"type": "string"},
                            "text": {"type": "string"},
                            "bullets": {"type": "array", "items": {"type": "string"}},
                            "table": _TABLE,
                            "chart": _CHART,
                            "notes": {"type": "string"},
                        },
                    },
                },
                "chart": _CHART,
                "body": {
                    "type": "string",
                    "description": "Plain body for txt/md/html when not sectioned.",
                },
                "page_numbers": {
                    "type": "boolean",
                    "description": "pdf/docx: 'Page X of Y' footer on every page.",
                },
                "toc": {
                    "type": "boolean",
                    "description": (
                        "pdf/docx: a table of contents from the section headings "
                        "(levels 1-3), with verified page numbers."
                    ),
                },
                "data": {"description": "Raw payload for json/yaml/xml/csv exports."},
            },
            "required": ["format"],
        },
    },
}
