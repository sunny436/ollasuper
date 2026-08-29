"""Human Resources capability — a first-class OllaSuper skill adapted from Anthropic's
`knowledge-work-plugins/human-resources` (9 skills covering all 12 named capabilities:
recruiting-pipeline, interview-prep, draft-offer, onboarding, performance-review,
policy-lookup/employee-handbook, comp-analysis/compensation-benchmarking,
people-report/people-analytics, org-planning).

Flag-gated by `ai_hr_enabled`; ONE model-routed skill that runs INLINE on the main
streaming agent (like Sales/Blog/SEO/Research/Data) — NO MCP/HRIS/ATS connector, no
second orchestrator, no dedicated agent runtime. Reuses the shared read-only OllaGraph
tools (`hr.*`→verified op-ids), the Data-Analysis compute tools (people-analytics + comp
CSV math), `generate_file` (offer letters / reports / onboarding docs), the ```chart
fence, and the `remember` memory tool (durable HR context). `comp.py` is the pure,
unit-tested reference for the compensation formulas the skill documents.
"""
