"""Operations capability — ONE model-routed `OPERATIONS_SKILL` (`skill.py`) that
STEP-0-classifies plain-language operations questions into the 9 source domains (vendor
review, process-doc/SOP, change request, capacity plan, status report, runbook, process
optimization, risk assessment, compliance tracking) and COMPOSES with the existing
Data-Analysis / Finance / HR / Sales / Deep-Research capabilities. Flag-gated by
`ai_operations_enabled`. Adapted from Anthropic's knowledge-work-plugins/operations — NO
MCP/ITSM connectors, NO deterministic tool (the source ships none). Leanest integration:
config flag + roster registration only (the HR pattern)."""
