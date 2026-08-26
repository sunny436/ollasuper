"""Phase 10 — the orchestration built-in tool specs (pure data).

The three meta-capabilities the orchestrator gives the general agent, mirroring
the RAG/memory built-in pattern (a reserved name + a static spec the model sees;
the executor routes the name to a handler BEFORE the registry lookup). Kept in
their own dependency-free module so both `executor.py` (routing + handlers) and
`base.py` (spec assembly) import them with no risk of an import cycle.

  * find_capabilities  — DISCOVERY: search the FULL registry + dynamically load
                         matches so they become callable this run (no Top-K
                         reachability ceiling).
  * delegate_to_agent  — run a specialized sub-agent (agent -> agent handoff).
  * request_clarification — signal that user input is required (a stop condition).
"""

from __future__ import annotations

FIND_CAPABILITIES_TOOL_NAME = "find_capabilities"
DELEGATE_TOOL_NAME = "delegate_to_agent"
CLARIFY_TOOL_NAME = "request_clarification"

FIND_CAPABILITIES_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": FIND_CAPABILITIES_TOOL_NAME,
        "description": (
            "Search the FULL catalogue of available tools/capabilities by intent "
            "and make the best matches immediately callable. Use this whenever the "
            "capability you need is not already among your bound tools — describe "
            "what you need to do (e.g. 'audit a page for broken links') and the "
            "matching tools become available to call on your next step. There is no "
            "fixed limit on what you can reach; refine the query to find anything."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What capability you need, in natural language.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max capabilities to surface (optional).",
                },
            },
            "required": ["query"],
        },
    },
}

DELEGATE_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": DELEGATE_TOOL_NAME,
        "description": (
            "Delegate a self-contained sub-task to a specialized agent (by role) "
            "and receive its result. Use for work that a focused agent handles "
            "better (e.g. 'research', 'data', 'document'). The sub-agent runs with "
            "its own tools under the same safety policy; you observe its result."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "role": {
                    "type": "string",
                    "description": "The specialized agent role to delegate to.",
                },
                "task": {
                    "type": "string",
                    "description": "The self-contained task for the sub-agent.",
                },
            },
            "required": ["role", "task"],
        },
    },
}

CLARIFY_TOOL_SPEC: dict = {
    "type": "function",
    "function": {
        "name": CLARIFY_TOOL_NAME,
        "description": (
            "Ask the user a clarifying question when the request is ambiguous or "
            "missing information you genuinely need. This ENDS the turn and returns "
            "the question to the user — use it instead of guessing."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The specific clarifying question for the user.",
                },
            },
            "required": ["question"],
        },
    },
}

# The reserved orchestration built-in names — never registry tools, never
# approval-gated, and seeded into build_tool_specs so no discovered tool can claim
# them.
ORCHESTRATION_BUILTIN_NAMES = frozenset(
    {FIND_CAPABILITIES_TOOL_NAME, DELEGATE_TOOL_NAME, CLARIFY_TOOL_NAME}
)
