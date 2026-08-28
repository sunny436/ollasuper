"""Data Analysis — a conversational, compute-backed data analyst.

Flag-gated by `ai_data_analysis_enabled`. OFF by default ⇒ the compute tools + skill
are never registered, tabular files inline exactly as today, and the runtime is
byte-identical. The deterministic compute (pandas/scipy/DuckDB) lets the model reason
over COMPUTED results of an uploaded CSV/XLSX instead of hallucinating math on inlined
data. SEO/Blog/Research skills are untouched; charts reuse the shipped chart renderer.
"""
