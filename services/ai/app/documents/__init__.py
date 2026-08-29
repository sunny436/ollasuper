"""Unified Documents capability (PPTX + PDF) — ONE model-routed skill.

Create / read / edit / process / convert presentations and PDFs with REAL inline
slide+page preview in the chat UI, on OllaSuper's existing orchestrator / skill /
artifact plumbing. Every operation reuses the deployed FOSS stack (python-pptx, pypdf,
pdfplumber, pypdfium2, rapidocr) — NO new Python dependency; the only new system
dependency is LibreOffice (flag-gated, sandboxed) for faithful PPTX visual preview and
PPTX<->PDF. Clean-room adaptation of Anthropic's proprietary `skills/pptx` +
`skills/pdf`
(methodology reused, no source code bundled).
"""
