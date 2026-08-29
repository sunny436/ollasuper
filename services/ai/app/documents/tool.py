"""The `document_ops` reserved built-in tool spec (Documents capability).

ONE model-decided tool with an `operation` enum spanning the PPTX + PDF matrix
(read/edit/merge/split/rotate/extract/tables/OCR/forms/convert). Pure data — both
`executor.py` (the handler) and `runner.py` (binds it when the flag is on) import it
with
no cycle, mirroring the generate_file / data-tool pattern. Uploaded files are referenced
BY NAME (from the <documents> turn listing); the handler resolves the name to a
storageId
server-side (the storageId never reaches the model) and fetches the bytes. Deterministic
Python performs the operation and stores a NEW artifact (with inline preview) or returns
extracted data — the model never emits file bytes.

Creating a NEW document from scratch is NOT here — that stays `generate_file`
(structured
spec → python-pptx / reportlab). `document_ops` operates on EXISTING uploaded files.
"""

from __future__ import annotations

DOCUMENT_OPS_TOOL_NAME = "document_ops"

# Operation groups (also used by the handler dispatch + labels).
PDF_OPS = frozenset(
    {
        "pdf_read",
        "pdf_extract_tables",
        "pdf_ocr",
        "pdf_extract_images",
        "pdf_merge",
        "pdf_split",
        "pdf_rotate",
        "pdf_crop",
        "pdf_encrypt",
        "pdf_decrypt",
        "pdf_watermark",
        "pdf_metadata",
        "pdf_form_fields",
        "pdf_fill_form",
        "pdf_form_structure",
        "pdf_fill_overlay",
        "pdf_to_pptx",
    }
)
PPTX_OPS = frozenset(
    {
        "pptx_read",
        "pptx_edit",
        "pptx_delete_slides",
        "pptx_reorder_slides",
        "pptx_duplicate_slide",
        "pptx_merge",
        "pptx_split",
        "pptx_to_pdf",
        "pptx_comments",
    }
)
DOCUMENT_OPERATIONS = tuple(sorted(PDF_OPS | PPTX_OPS))

_BBOX = {
    "type": "array",
    "items": {"type": "number"},
    "description": "[x0, top, x1, bottom] in the page's coordinate space.",
}

DOCUMENT_OPS_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": DOCUMENT_OPS_TOOL_NAME,
        "description": (
            "Operate on an EXISTING uploaded PDF or PowerPoint file (referenced by its "
            "name from the <documents> list). Use for: read/analyse a deck or PDF, "
            "extract text/tables/images, OCR a scanned PDF, edit a deck (add/duplicate/"
            "delete/reorder slides, edit text/notes), merge/split/rotate/crop, "
            "encrypt/decrypt (password), watermark, read/fill PDF forms, and convert "
            "PPTX->PDF or PDF->PPTX. It returns extracted data and/or produces a NEW "
            "downloadable file attached to the chat with an inline preview. To CREATE "
            "a brand-new document from a prompt (no uploaded file), use generate_file "
            "instead. Never invent file content, form values, or page contents."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": list(DOCUMENT_OPERATIONS),
                    "description": (
                        "The operation. pdf_*: read/extract_tables/ocr/extract_images/"
                        "merge/split/rotate/crop/encrypt/decrypt/watermark/metadata/"
                        "form_fields/fill_form/form_structure/fill_overlay/to_pptx. "
                        "pptx_*: "
                        "read/edit/delete_slides/reorder_slides/duplicate_slide/"
                        "merge/split/to_pdf/comments."
                    ),
                },
                "file": {
                    "type": "string",
                    "description": (
                        "The uploaded file's name exactly as listed in <documents> "
                        "(single-file operations)."
                    ),
                },
                "files": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Ordered file names for merge (2+).",
                },
                "pages": {
                    "type": "string",
                    "description": (
                        "1-based page/slide selection, e.g. '1,3-5,8' or '2-end'. "
                        "Omit for the whole document."
                    ),
                },
                "password": {
                    "type": "string",
                    "description": "Password to open an encrypted PDF (pdf_decrypt).",
                },
                "user_password": {
                    "type": "string",
                    "description": "Open password for pdf_encrypt.",
                },
                "owner_password": {
                    "type": "string",
                    "description": "Permissions/owner password for pdf_encrypt.",
                },
                "rotation": {
                    "type": "integer",
                    "description": "Degrees clockwise (90/180/270) for pdf_rotate.",
                },
                "watermark_text": {
                    "type": "string",
                    "description": "Diagonal watermark text for pdf_watermark.",
                },
                "box": {**_BBOX, "description": "Crop box for pdf_crop (points)."},
                "metadata": {
                    "type": "object",
                    "description": (
                        "title/author/subject/keywords for a pdf_metadata "
                        "set."
                    ),
                },
                "values": {
                    "type": "object",
                    "description": (
                        "field_name -> value for pdf_fill_form (fillable AcroForm). "
                        "Checkboxes take the field's on/off value; radios the option."
                    ),
                },
                "placements": {
                    "type": "array",
                    "description": (
                        "For pdf_fill_overlay (non-fillable): text to stamp at exact "
                        "coordinates. Read pdf_form_structure first to get the boxes."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "page": {"type": "integer"},
                            "bbox": _BBOX,
                            "text": {"type": "string"},
                            "font_size": {"type": "number"},
                        },
                    },
                },
                "slides": {
                    "type": "array",
                    "description": (
                        "For pptx_edit: per-slide edits. Each item targets a slide by "
                        "1-based `index` (or omit index + set `add`:true to append) "
                        "and sets title/bullets/text/notes/table."
                    ),
                    "items": {
                        "type": "object",
                        "properties": {
                            "index": {"type": "integer"},
                            "add": {"type": "boolean"},
                            "title": {"type": "string"},
                            "subtitle": {"type": "string"},
                            "text": {"type": "string"},
                            "bullets": {"type": "array", "items": {"type": "string"}},
                            "notes": {"type": "string"},
                        },
                    },
                },
                "indexes": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "1-based slide numbers for pptx_delete_slides.",
                },
                "order": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": (
                        "New slide order as 1-based indexes for pptx_reorder_slides "
                        "(a permutation of the current slides)."
                    ),
                },
                "index": {
                    "type": "integer",
                    "description": "1-based source slide for pptx_duplicate_slide.",
                },
                "after": {
                    "type": "integer",
                    "description": (
                        "Insert the duplicate after this 1-based slide "
                        "(pptx_duplicate_slide; default = right after the source)."
                    ),
                },
                "filename": {
                    "type": "string",
                    "description": "Optional base name for the produced file.",
                },
            },
            "required": ["operation"],
        },
    },
}
