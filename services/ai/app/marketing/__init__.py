"""Marketing capability — ONE model-routed `MARKETING_SKILL` router (`skill.py`) that
STEP-0-classifies plain-language queries into the marketing pods and COMPOSES with the
existing SEO / Blog / Deep-Research / Data-Analysis / Sales / Finance capabilities.
Flag-gated by `ai_marketing_enabled`. Deterministic marketing math is the reserved
`marketing_calc` tool (`tool.py` -> `calc.py`); the MARKETING-owned specialist playbooks
are the reserved `marketing_reference` tool (`tool.py` -> `references.py`)."""
