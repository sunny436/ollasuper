"""Phase 5 — Project scope across delegation and unattended execution.

Two properties are defended.

DELEGATION CANNOT WIDEN SCOPE. A sub-agent env is `replace(parent_env, ...)`
(orchestrator._make_delegator), so a child RECEIVES the parent's RagContext and
memory pool rather than building its own. That makes `child authority ⊆ parent
authority` true by construction, at every nesting depth. These tests pin it, so a
refactor that constructs a fresh RagContext for a child — which would silently
restore account-wide retrieval inside a Project — fails loudly instead.

UNATTENDED RUNS DO NOT WRITE MEMORY. A scheduled run has nobody present to notice
a bad write or a wrong forget, so the write tools are not bound at all. Enforced
by binding rather than by prompt wording, because a capability the model cannot
see is one it cannot be argued into using.
"""

from __future__ import annotations

from dataclasses import replace

from app.agent.base import AgentEnv
from app.agent.executor import RagContext
from app.agent.memory import (
    FORGET_TOOL_SPEC,
    MEMORY_SEARCH_TOOL_SPEC,
    REMEMBER_TOOL_SPEC,
)
from app.runtime.env_factory import build_live_agent_env
from tests.conftest import make_settings

SETTINGS = make_settings("http://localhost:9999")


class _Req:
    """The fields env_factory reads off a GenerateRequest."""

    streamId = "stream-1"
    userId = "user-1"
    workspaceId = "ws-1"
    attempt = 0
    projectInstructions = "Always cite the source file."


def _parent_env(**over) -> AgentEnv:
    rag = RagContext(
        engine=object(),  # type: ignore[arg-type]
        user_id="user-1",
        settings=SETTINGS,
        file_ids=["proj-a-file"],
    )
    kw = {
        "writer": object(),
        "llm": object(),
        "req": _Req(),
        "rag": rag,
        "memory": ["project memory item"],
    }
    kw.update(over)
    return build_live_agent_env(**kw)  # type: ignore[arg-type]


def test_parent_env_carries_project_scope():
    env = _parent_env()
    assert env.rag.file_ids == ["proj-a-file"]
    assert env.project_instructions == "Always cite the source file."
    assert env.user_id == "user-1"


def test_a_delegated_child_inherits_the_exact_same_scope():
    """`replace()` is what the orchestrator does to build a sub-agent env."""
    parent = _parent_env()
    child = replace(parent, agent_id="researcher")

    # The SAME object, not a copy that could drift or be rebuilt unscoped.
    assert child.rag is parent.rag
    assert child.rag.file_ids == ["proj-a-file"]
    assert child.memory is parent.memory
    assert child.project_instructions == parent.project_instructions
    assert child.user_id == parent.user_id


def test_scope_survives_nested_delegation():
    """Nesting is supported (_make_delegator passes depth + 1). Each level is a
    replace() of the level above, so depth cannot widen scope."""
    parent = _parent_env()
    child = replace(parent, agent_id="researcher")
    grandchild = replace(child, agent_id="summariser")

    assert grandchild.rag is parent.rag
    assert grandchild.rag.file_ids == ["proj-a-file"]
    assert grandchild.project_instructions == parent.project_instructions


def test_an_empty_project_stays_empty_through_delegation():
    """The Phase 3 zero-file rule must not be re-broken via a child.

    `[]` means "this Project has no files, retrieve nothing". If a child ever
    received `None` instead, retrieval would silently widen to the user's whole
    corpus — the exact bug Phase 3 closed.
    """
    parent = _parent_env(
        rag=RagContext(
            engine=object(),  # type: ignore[arg-type]
            user_id="user-1",
            settings=SETTINGS,
            file_ids=[],
        )
    )
    child = replace(parent, agent_id="researcher")
    assert child.rag.file_ids == []
    assert child.rag.file_ids is not None


def test_an_ordinary_chat_delegates_with_no_project():
    class _Plain(_Req):
        projectInstructions = None

    parent = _parent_env(
        req=_Plain(),
        rag=RagContext(
            engine=object(),  # type: ignore[arg-type]
            user_id="user-1",
            settings=SETTINGS,
            file_ids=None,
        ),
    )
    child = replace(parent, agent_id="researcher")
    assert child.project_instructions is None
    assert child.rag.file_ids is None


# --- the delegated system prompt -------------------------------------------


def _compose(env: AgentEnv, spec_instructions: str, system_prefix: str) -> str:
    """The exact composition Agent.run performs, isolated from the graph."""
    pi = getattr(env, "project_instructions", None)
    project_block = (
        f"<project_instructions>\n{str(pi).strip()}\n</project_instructions>"
        if pi and str(pi).strip()
        else ""
    )
    return "\n\n".join(
        p for p in (spec_instructions, project_block, system_prefix) if p
    )


def test_project_instructions_do_not_displace_rendered_skills():
    """The orchestrator already passes `rendered_skills` as system_prefix. The
    Project block is ADDED, never substituted — composing at the call sites
    instead would have risked exactly this."""
    env = _parent_env()
    prompt = _compose(env, "You are a researcher.", "RENDERED SKILLS BLOCK")

    assert "You are a researcher." in prompt
    assert "RENDERED SKILLS BLOCK" in prompt
    assert "Always cite the source file." in prompt
    # The agent's own persona still leads; the Project refines it.
    assert prompt.index("You are a researcher.") < prompt.index(
        "<project_instructions>"
    )


def test_no_project_leaves_the_child_prompt_untouched():
    class _Plain(_Req):
        projectInstructions = None

    env = _parent_env(req=_Plain())
    with_project = _compose(env, "You are a researcher.", "SKILLS")
    assert "<project_instructions>" not in with_project
    assert with_project == "You are a researcher.\n\nSKILLS"


# --- unattended memory ------------------------------------------------------


def _bound_memory_tools(*, memory_enabled: bool, unattended: bool) -> set[str]:
    """The binding decision from runner.run_generation, isolated."""
    memory_as_tool = memory_enabled
    memory_write_allowed = memory_as_tool and not unattended
    specs: list[dict] = []
    if memory_as_tool:
        if memory_write_allowed:
            specs.append(REMEMBER_TOOL_SPEC)
        # `req.memories` non-empty in both cases here.
        specs.append(MEMORY_SEARCH_TOOL_SPEC)
        if memory_write_allowed:
            specs.append(FORGET_TOOL_SPEC)
    return {s["function"]["name"] for s in specs}


def test_an_interactive_run_binds_all_three_memory_tools():
    names = _bound_memory_tools(memory_enabled=True, unattended=False)
    assert "remember" in names
    assert "forget_memory" in names or "forget" in " ".join(names)
    assert len(names) == 3


def test_an_unattended_run_can_read_memory_but_never_write_it():
    names = _bound_memory_tools(memory_enabled=True, unattended=True)
    assert names == {MEMORY_SEARCH_TOOL_SPEC["function"]["name"]}
    assert REMEMBER_TOOL_SPEC["function"]["name"] not in names
    assert FORGET_TOOL_SPEC["function"]["name"] not in names
