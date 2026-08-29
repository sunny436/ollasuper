"""Sales capability — a first-class OllaSuper skill adapted from Anthropic's
`knowledge-work-plugins/sales` methodology (account research, call prep, outreach,
call summary, pipeline review, forecast, competitive intelligence, asset creation,
daily briefing, deal strategy).

Flag-gated by `ai_sales_enabled`; ONE model-routed skill that runs INLINE on the main
streaming agent (like Blog / SEO / Deep Research / Data Analysis) — no MCP/CRM
connector, no second orchestrator, no dedicated agent runtime. Reuses the shared
read-only OllaGraph tools, the Data-Analysis compute tools (for CSV forecast/pipeline
math), `generate_file` (assets), the ```chart fence, and the `remember` memory tool
(persistent seller context). `forecast.py` holds the pure, unit-tested reference math
that pins the skill's documented forecast/pipeline constants.
"""
