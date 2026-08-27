"""Phase 4 — the named data-quality flags for first-party (GSC / GA4 / PSI) evidence.

Single source of truth so a flag string is spelled the same in every adapter, the
report, and the tests. Each flag's MEANING is grounded in the verified Google API
semantics (see the plan's research), NOT common myths:
  * GSC "25k/50k" is a ROW-EXPORT cap, not a query quota.
  * GSC anonymization has no API field — it's inferred from summed-rows < totals.
  * URL Inspection has no live-test; "indexed != live" is a googleCanonical vs
    userCanonical mismatch.
  * GA4 exposes exact metadata: samplingMetadatas / dataLossFromOtherRow /
    subjectToThresholding / schemaRestrictionResponse.
  * PSI field data (CrUX) can be ABSENT → fall back to lab, never present lab as CWV.
"""

from __future__ import annotations

# --- GSC Search Analytics --------------------------------------------------
TOP_ROWS_ONLY = "TOP_ROWS_ONLY"  # a page returned rowLimit=25,000 (more may exist)
CAPPED_50K = "CAPPED_50K"  # the 50k row-export ceiling reached (NOT a query quota)
ANONYMIZED = "ANONYMIZED"  # anonymized queries omitted (privacy) — see below
DIMENSION_DATA_LOSS = "DIMENSION_DATA_LOSS"  # summed rows < totals (query-dimensioned)
PROVISIONAL = "PROVISIONAL"  # dataState=all / within first_incomplete_date
QUOTA_SAMPLED = "QUOTA_SAMPLED"  # QPM/quota exhaustion => partial/degraded

# --- GSC URL Inspection ----------------------------------------------------
INDEXED_VERSION_NOT_LIVE = "INDEXED_VERSION_NOT_LIVE"  # indexed snapshot only (no live)
CANONICAL_MISMATCH = "CANONICAL_MISMATCH"  # googleCanonical != userCanonical

# --- GA4 -------------------------------------------------------------------
GA4_SAMPLED = "GA4_SAMPLED"  # samplingMetadatas present
THRESHOLDED = "THRESHOLDED"  # subjectToThresholding (privacy withholding)
OTHER_ROW_LOSS = "OTHER_ROW_LOSS"  # dataLossFromOtherRow (high-cardinality rollup)
METRICS_RESTRICTED = "METRICS_RESTRICTED"  # schemaRestrictionResponse
APPROXIMATE_COUNTS = "APPROXIMATE_COUNTS"  # HLL++ unique-count estimates

# --- PSI / CrUX ------------------------------------------------------------
FIELD_DATA = "FIELD_DATA"  # CrUX real-user field data present (p75)
LAB_DATA = "LAB_DATA"  # Lighthouse synthetic lab data
NO_FIELD_DATA = "NO_FIELD_DATA"  # insufficient CrUX coverage → lab fallback only

# --- cross-provider degradation --------------------------------------------
NOT_CONNECTED = "NOT_CONNECTED"  # the user hasn't connected this provider
PROVIDER_OUTAGE = "PROVIDER_OUTAGE"  # the provider API failed / was unreachable
PARTIAL = "PARTIAL"  # some data returned, some missing

ALL_FLAGS: frozenset[str] = frozenset(
    {
        TOP_ROWS_ONLY,
        CAPPED_50K,
        ANONYMIZED,
        DIMENSION_DATA_LOSS,
        PROVISIONAL,
        QUOTA_SAMPLED,
        INDEXED_VERSION_NOT_LIVE,
        CANONICAL_MISMATCH,
        GA4_SAMPLED,
        THRESHOLDED,
        OTHER_ROW_LOSS,
        METRICS_RESTRICTED,
        APPROXIMATE_COUNTS,
        FIELD_DATA,
        LAB_DATA,
        NO_FIELD_DATA,
        NOT_CONNECTED,
        PROVIDER_OUTAGE,
        PARTIAL,
    }
)
