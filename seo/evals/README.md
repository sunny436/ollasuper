# SEO evals

Frozen corpora + (later) graded suites for the SEO system. Phase 0 provides only the **baseline
corpus** (`fixtures/baseline-corpus.md`) — the current pre-SEO runtime behavior, pinned so later
phases prove no regression.

Later phases add graded suites (per the Codex plan): `activation/`, `routing/`, `evidence/`,
`safety/`, `recovery/` — each with minimum sample sizes, failure-cost weighting, and 95% CIs, plus
**hard gates** (100% on authz/tenant-isolation/PII/secret/forbidden-write; 100% schema validity &
evidence-reference integrity; 0 fabricated source URLs; no provider estimate labeled a Google metric;
no NOT_TESTED silently treated as a failure/zero).

Outcome proof (rankings/traffic/leads) is explicitly **out of scope** until OllaSuper runs
preregistered controlled/quasi-experimental multi-site evaluations — until then the system is
"validated for workflow correctness," never "proven SEO outcomes."
