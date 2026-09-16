"""Humanizer — the internal final-writing stage (audit of AI-writing tells).

Adapted from `blader/humanizer` v3.0.0 (MIT): its 25-pattern taxonomy, severity
rule, voice guidance and "do not" list. Nothing is copied from its plugin/CLI
surface — the detector here is ours, because the upstream repo ships no detector
(its `scripts/` holds only a package validator).

Four modules, all pure and hermetic (no I/O, no network, no clock):
  patterns.py  — protected spans, the 25 detectors, severity, the human-voice score
  preserve.py  — the final validation: nothing factual may be lost or invented
  tool.py      — the `humanize_check` reserved tool (detect | verify)
  guidance.py  — the system-prompt block that places the stage in the pipeline
"""

from __future__ import annotations
