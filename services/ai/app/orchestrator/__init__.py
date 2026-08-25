"""Phase 10 — the orchestrator + dynamic capability routing.

Kept deliberately empty of heavy imports: `executor.py`/`base.py` import the
pure-data orchestration tool specs from `app/agent/orchestration_tools.py`, and
`orchestrator.py` imports `Agent` (which imports `executor`) — so importing this
package must not pull in `orchestrator.py` (that would create a cycle). Import the
concrete classes from their modules directly.
"""
