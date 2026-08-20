"""Document ingestion for the File Knowledge System.

detect -> parser registry -> normalize -> chunk -> embed -> persist (pgvector).
Everything CPU-bound (pypdf/python-docx/openpyxl/bs4) runs in a thread under a
timeout; OCR is async network I/O and takes the native path. See pipeline.py.
"""
