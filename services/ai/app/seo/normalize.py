"""Phase 4 — co-present GSC and GA4 evidence WITHOUT pretending they reconcile.

GSC (Google's index/search side: clicks, impressions, position) and GA4 (the site's
analytics: sessions, users, conversions) measure DIFFERENT populations with different
attribution, time zones, and de-duplication. A clicks-vs-sessions row-by-row join is a
classic false-precision trap. This helper keeps the two streams SEPARATE, labels each
by provider, and records `reconciled: false` with the reason — so a report can show
both next to each other without implying they should match.
"""

from __future__ import annotations

_WHY = (
    "GSC measures Google Search (impressions/clicks/position at Google's index); GA4 "
    "measures on-site behavior (sessions/users/conversions). They use different "
    "populations, attribution, time zones, and de-duplication, so their rows and "
    "totals are NOT expected to match and must not be joined row-by-row."
)


def co_present(gsc: dict | None, ga4: dict | None) -> dict:
    """Return both evidence streams side by side, provenance-labeled, explicitly
    NON-reconciled. Either side may be absent (not connected / no data)."""
    return {
        "reconciled": False,
        "reconciliation_note": _WHY,
        "search_console": {"provider": "gsc", "evidence": gsc} if gsc else None,
        "analytics": {"provider": "ga4", "evidence": ga4} if ga4 else None,
    }
