# Provider / data-source lifecycle matrix (stub — for connector phases)

Not used in Phase 0 (read-only chat over existing Ollagraph tools needs none of these). Captured here
so the connector/research phases start from current provider reality, per the Codex plan. **Verify each
date/status against the provider's own docs at implementation time — do not trust this table blindly.**

| Capability | Decision | Note |
|---|---|---|
| **Ollagraph** (this repo's tool provider) | LIVE | 147 tools discovered/bound today; SEO/scrape/intel surface. Read-only SEO tools only for the agent. |
| Google Search Console API | BUILD (OAuth connector) | Documented: Search Analytics, Sitemaps, Sites, URL Inspection **only**. No API for Manual Actions, Security Issues, Crawl Stats, Page Indexing, live URL test, Rich Results, or the Generative-AI report. |
| GA4 Data API | BUILD (OAuth connector) | Persist samplingMetadatas, subjectToThresholding, dataLossFromOtherRow, quota, freshness. Normalize + trend-correlate with GSC, do not row-reconcile. |
| PageSpeed Insights / CrUX | BUILD | Separate field (CrUX) vs lab (Lighthouse) evidence. |
| Azure Bing Search APIs | DO NOT USE | Retired 2025-08-11. |
| Bing Webmaster API | REST/JSON only | Legacy SOAP/POX retires 2026-08-31. |
| Google Custom Search JSON API | DO NOT ADOPT | Closed to new customers; discontinued 2027-01-01. |
| Google Trends API | LIMITED_ALPHA | Provide export/licensed fallback. |
| SERP / rank tracking | Licensed provider adapter only | Preserve engine/locale/geo/device/timestamp/provenance. |
| Google Ads Keyword Planner | POLICY_REVIEW | "Competition" = paid inventory, not organic difficulty. |
| Google Indexing API | JobPosting + BroadcastEvent/VideoObject only | Not generic URLs. |
| GBP / local | BLOCKED_POLICY_REVIEW | Separate compliance design (30-day storage cap, consent, no SaaS-on-provider-project). |

### GSC data-quality flags to carry as evidence metadata (later phases)
`TOP_ROWS_ONLY · CAPPED_50K · ANONYMIZED · DIMENSION_DATA_LOSS · PROVISIONAL ·
INDEXED_VERSION_NOT_LIVE · QUOTA_SAMPLED`. Search Analytics is delayed ~2-3 days; URL Inspection is
the indexed (not live) version, 2,000/day + 600/min per site → sample large sites. The 2026 Generative
AI report has no documented Search Analytics type → treat as manual-export evidence.
