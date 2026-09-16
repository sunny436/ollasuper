"""Security audits in chat — adapted from openai/codex-security (Apache-2.0).

Only the METHOD and CONTRACTS are adapted (the core-scan auditor/investigator
perspectives, the per-finding validation checklist, attack-path fields, severity
calibration, a findings/coverage subset, diff scoping). Codex Security's SQLite
workbench and MCP app are tied to the Codex host and are not used.

Two invariants every module here serves:

  * READ-ONLY BY DEFAULT. An audit never modifies, commits, pushes, deletes or
    deploys. The only write is `security_apply_fix`, an approval-gated registry
    tool bound on an explicit fix request.
  * NOTHING IS "CLEAN" BY OMISSION. Coverage, access and stage outcomes come from
    recorded executions, never from what the model says it did; a skipped or
    failed stage, or an inaccessible repository, can never render as a clean
    result.
"""
