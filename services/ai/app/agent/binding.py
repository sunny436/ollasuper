"""What an approval is FOR: the binding between a human's "yes" and one call.

THE PROBLEM THIS SOLVES (audit H-07). An approval used to be identified by
`tool_id + sha256(args)[:16]`. Everything else about the call — which
connection, which endpoint, what the tool's schema and description said when
the user read the approval card, whether the definition was a read or a write —
was outside the identity. So a server that changed `send_message`'s schema or
implementation after the user approved `send_message({channel, text})`, or a
same-named tool discovered on a different connection, executed under the
original approval. The user approved one thing and another thing ran.

THE FIX IS PURE. `approval_binding` folds every fact the user's decision rested
on into one digest, and `approval_id_for` makes that digest the approval's
identity. Nothing else changes: `_run_one` recomputes the id from the CURRENT
tool definition and args, looks it up in the approvals it was given, and finds
either the same approval (nothing changed) or nothing (something changed) — in
which case it parks a FRESH request and the stale token is simply never used.
Resume needs no special case, because "the definition changed" and "this call
was never approved" are, correctly, the same situation.

WHAT IS BOUND, and why each item is there:

    tool_id       the tool the user saw named
    provider      `mcp:<slug>` — the server, by operator-assigned identity
    origin        `<connection_id>|<endpoint_url>` for an MCP tool: the SAME
                  slug on a different connection (another user's, or after a
                  reconnect to a re-curated endpoint) is a different approval
    side_effect   read vs write as classified at discovery
    description   what the approval card told the user the tool does
    input_schema  the contract the args were validated against
    args          the exact arguments, canonicalised
    sources       Phase 3: which OTHER connectors' data those args carry, so
                  approving "send Gmail data to Slack" does not also approve
                  "send Notion data to Slack" with identical args

The digest is truncated to 32 hex characters (128 bits) — well beyond any
collision concern for an identifier and short enough for a durable row key.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any

__all__ = ["approval_binding", "approval_id_for", "canonical_args"]


def canonical_args(args: Any) -> str:
    """One spelling per argument set, whatever key order the model used."""
    payload = args if isinstance(args, dict) else {}
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def approval_binding(tool: Any, args: Any, *, sources: Iterable[str] = ()) -> str:
    """The full 64-hex digest of everything the approval rests on."""
    material = {
        "tool_id": str(getattr(tool, "tool_id", "") or ""),
        "provider": str(getattr(tool, "provider", "") or ""),
        "origin": str(getattr(tool, "origin", "") or ""),
        "side_effect": str(getattr(tool, "side_effect", "") or ""),
        "description": _digest(str(getattr(tool, "description", "") or "")),
        "schema": _digest(
            json.dumps(
                getattr(tool, "input_schema", None) or {},
                sort_keys=True,
                separators=(",", ":"),
                default=str,
            )
        ),
        "args": canonical_args(args),
        "sources": sorted({str(s) for s in sources if s}),
    }
    return _digest(json.dumps(material, sort_keys=True, separators=(",", ":")))


def approval_id_for(tool: Any, args: Any, *, sources: Iterable[str] = ()) -> str:
    """`<tool_id>:<binding[:32]>` — the durable identity of one approval."""
    tool_id = str(getattr(tool, "tool_id", "") or "")
    return f"{tool_id}:{approval_binding(tool, args, sources=sources)[:32]}"
