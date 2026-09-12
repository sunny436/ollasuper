"""The scheduler's entry point is STRUCTURALLY intact.

WHY THIS FILE EXISTS — a production incident, caused by this program.

Phase 6 added `mcp_registry_sync` to `app/scheduler/main.py` and inserted it
INTO THE MIDDLE of `_serve()`, between `_EXECUTOR = build_executor(...)` and
`_assert_dbos_version()`. Python took the decorators at face value: `_serve`
ended early with an implicit return, and the entire DBOS bootstrap — launch,
queue registration, `apply_schedules_async`, the health server and the
`await stop.wait()` that keeps the process alive — became the body of
`mcp_registry_sync` instead.

The service then started, configured logging, built the executor, returned, and
exited. Measured on production after the Phase 8 deploy:

    Active: inactive (dead)   Process: ... (code=exited, status=0/SUCCESS)
    Duration: 2.212s

systemd reported a CLEAN shutdown. Nothing logged an error. Twenty-five
scheduled tasks silently stopped running, and the only symptom was the absence
of a log line that used to appear every thirty seconds.

WHY NOTHING CAUGHT IT. The whole suite, 2500 tests, never calls `_serve` —
it blocks forever by design, so no test could. The unit tests for the sync
workflow passed, because the workflow function existed and its own first lines
were correct. That is the same failure this program has now hit four times: the
unit is right and the seam in front of it is not, and only a test that asserts
the SEAM can see it.

So these tests read the module's AST. They never execute it, which is the point
— a test that could run `_serve` would hang, and one that mocks its way past the
bootstrap would be asserting the mock.
"""

from __future__ import annotations

import ast
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "app" / "scheduler" / "main.py"


def _tree() -> ast.Module:
    return ast.parse(MODULE.read_text(encoding="utf-8"))


def _functions(tree: ast.Module) -> dict[str, ast.AST]:
    return {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
    }


def test_no_decorated_workflow_is_nested_inside_another_function():
    """THE regression. A decorated function defined inside another one silently
    truncates its host, and Python will not complain."""
    tree = _tree()
    top_level = {
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
    }
    nested_decorated: list[str] = []
    for host in top_level:
        for child in ast.walk(host):
            if child is host:
                continue
            if (
                isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef)
                and child.decorator_list
            ):
                nested_decorated.append(f"{host.name} contains {child.name}")
    assert nested_decorated == [], nested_decorated


def test_serve_still_contains_the_whole_bootstrap():
    """Each of these is a step the process cannot run without.

    Asserted by NAME inside `_serve`'s own subtree, so moving any one of them
    out — which is exactly what happened — fails here rather than in production
    at the next restart.
    """
    serve = _functions(_tree())["_serve"]
    calls = {
        node.func.attr
        for node in ast.walk(serve)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    } | {
        node.func.id
        for node in ast.walk(serve)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    for required in (
        "launch",  # DBOS.launch()
        "register_queue_async",
        "apply_schedules_async",
        "serve_health",
        "_assert_dbos_version",
        "mark_started",
    ):
        assert required in calls, f"{required} is no longer inside _serve"


def test_serve_blocks_rather_than_returning():
    """The process must PARK. An entry point that returns is a service that
    exits 0 and takes every scheduled task with it — silently, because a clean
    exit looks like a clean shutdown."""
    serve = _functions(_tree())["_serve"]
    awaits = [
        node
        for node in ast.walk(serve)
        if isinstance(node, ast.Await)
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Attribute)
        and node.value.func.attr == "wait"
    ]
    assert awaits, "_serve no longer awaits anything that blocks"


def test_the_sync_workflow_is_registered_at_module_scope():
    """`@DBOS.scheduled` registers at import time, so the function has to be a
    module-level sibling of `_serve` — not something defined while `_serve`
    runs, which would register nothing until the first call."""
    tree = _tree()
    names = {
        node.name
        for node in tree.body
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
    }
    assert "mcp_registry_sync" in names
    assert "_serve" in names


def test_the_sync_workflow_body_is_only_the_sync():
    """It swallowed 40 lines of unrelated bootstrap once. Bounding its size is a
    blunt check, and a blunt check that fires beats a subtle one that does not."""
    sync = _functions(_tree())["mcp_registry_sync"]
    span = (sync.end_lineno or 0) - sync.lineno
    assert span < 60, (
        f"mcp_registry_sync is {span} lines — is it holding something else?"
    )
    calls = {
        node.func.attr
        for node in ast.walk(sync)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    # None of the bootstrap may live here.
    for forbidden in ("launch", "register_queue_async", "apply_schedules_async"):
        assert forbidden not in calls, f"{forbidden} is inside the sync workflow"


def test_the_sync_workflow_checks_its_flag_before_doing_anything():
    """`@DBOS.scheduled` fires regardless of configuration, so the FLAG CHECK IS
    THE GATE. It must be the first thing the body does, before any engine is
    created or any HTTP client is built."""
    sync = _functions(_tree())["mcp_registry_sync"]
    body = [n for n in sync.body if not isinstance(n, ast.Expr)]  # skip docstring
    # settings = ...  then  if not settings.mcp_sync_enabled: return
    guard = body[1]
    assert isinstance(guard, ast.If), ast.dump(guard)[:120]
    assert "mcp_sync_enabled" in ast.dump(guard.test)
    assert any(isinstance(n, ast.Return) for n in guard.body)
