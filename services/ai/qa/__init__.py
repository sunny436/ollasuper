"""QA-only infrastructure. NOT imported by `app/` and never shipped in a turn.

Everything here exists to be attacked. It is a deliberately hostile MCP server
used to prove that OllaSuper's policy, approval gate and rendering survive a
server that lies, stalls, floods and tries to give the model orders.

IT MUST NEVER BE CURATED OUTSIDE A QA WINDOW. `trusted=false`, one row, flags on
only while a run is in progress, row removed at teardown.
"""
