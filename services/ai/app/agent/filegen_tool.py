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
    "description": "A chart to render/embed.",
    "properties": {
        "type": {
            "type": "string",
            "enum": ["bar", "line", "pie", "donut", "scatter", "area", "histogram"],
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
_TABLE = {
    "type": "object",
    "properties": {
        "columns": {"type": "array", "items": {"type": "string"}},
        "rows": {"type": "array", "items": {"type": "array"}},
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
            "data in `sheets`, slides in `slides`, and a single chart/image in `chart`."
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
                            "rows": {"type": "array", "items": {"type": "array"}},
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
                "data": {"description": "Raw payload for json/yaml/xml/csv exports."},
            },
            "required": ["format"],
        },
    },
}
