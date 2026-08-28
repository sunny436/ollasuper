"""SEO severity levels — the one typed value the rule base (checks.py) still uses.

The structured SEOReport/SEOFinding/report-envelope contract was removed when the
audit switched to a streamed MARKDOWN report written by the model (no schema, no
report card). Only the severity vocabulary survives, to tag the rules in checks.py.
"""

from __future__ import annotations

from enum import StrEnum


class Severity(StrEnum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"
