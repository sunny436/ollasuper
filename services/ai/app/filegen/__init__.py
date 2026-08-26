"""File Generation System — deterministic Python renderers for downloadable files.

The model hands a structured `FileSpec`; these renderers turn it into a
professional PDF/DOCX/XLSX/PPTX/CSV/chart/image. No model-generated code runs; the
renderers take structured data only. Heavy (binary/chart) renders run in the shared
process pool (crash-isolated, off the event loop); trivial text formats render inline.
"""
