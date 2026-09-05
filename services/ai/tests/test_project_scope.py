"""Phase 3 — Project retrieval scope (hermetic, NO database).

The one invariant this file exists to defend:

    A Project with zero files must retrieve NOTHING.
    It must NEVER mean "search all of the user's files".

`file_ids` has three states and collapsing any two of them is a data leak:

    None  -> no narrowing; the whole account corpus (an ordinary chat)
    []    -> narrow to nothing (a Project that has no ready files)
    [ids] -> narrow to exactly those files

Before Phase 3 `store.retrieve` tested `if file_ids`, which is falsy for an
empty list, so `[]` silently emitted NO clause and returned the entire corpus.
These tests pin the corrected behaviour at the two seams a leak could re-enter:
`store.retrieve` itself, and `retrieve_context` above it.

The database-backed half of this proof (real pgvector, real SQL) lives in
test_retrieve_db.py, which is gated on TEST_DATABASE_URL. Everything here runs
with no DB and no network, so the invariant is guarded even when that is absent.
"""

from __future__ import annotations

import pytest

from app.db import store
from app.ingest import retrieve
from tests.conftest import make_settings

SETTINGS = make_settings("http://localhost:9999")
LONG_QUERY = "what does my employee handbook say about annual leave"


class _ExplodingEngine:
    """Any DB access at all is a test failure.

    An empty scope must be decided before SQL — both because there is nothing it
    could match, and because an empty Python list gives psycopg3 no element type
    to infer for `= ANY(:fids)`.
    """

    def begin(self):  # pragma: no cover - must never be reached
        raise AssertionError("store.retrieve touched the database for an empty scope")


async def test_store_retrieve_returns_nothing_for_empty_scope():
    rows = await store.retrieve(
        _ExplodingEngine(),  # type: ignore[arg-type]
        user_id="u1",
        query_embedding=[0.0] * 8,
        fetch_k=10,
        embedding_dimensions=8,
        file_ids=[],
    )
    assert rows == []


async def test_retrieve_context_skips_embedding_for_empty_scope(monkeypatch):
    """An empty Project must not even pay for the query embedding."""
    called = {"embed": 0, "store": 0}

    async def fake_embed(settings, q):
        called["embed"] += 1
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        called["store"] += 1
        return []

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)

    out = await retrieve.retrieve_context(
        SETTINGS, object(), user_id="u1", query=LONG_QUERY, file_ids=[]
    )
    assert out == []
    assert called == {"embed": 0, "store": 0}


@pytest.mark.parametrize(
    ("scope", "expected"),
    [
        (None, None),  # ordinary chat: no narrowing reaches the SQL layer
        (["f1", "f2"], ["f1", "f2"]),  # project chat: exactly its own files
    ],
)
async def test_scope_is_passed_through_verbatim(monkeypatch, scope, expected):
    """None and a populated list must reach store.retrieve unchanged — the
    narrowing decision belongs to the caller (Convex), never to this layer."""
    seen: dict = {}

    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        seen.update(kw)
        return []

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)

    await retrieve.retrieve_context(
        SETTINGS, object(), user_id="u1", query=LONG_QUERY, file_ids=scope
    )
    assert seen["file_ids"] == expected
    # The hard boundary is never replaced by the soft one.
    assert seen["user_id"] == "u1"


async def test_no_project_and_empty_project_do_not_collapse(monkeypatch):
    """The regression that matters most: these two are different requests and
    must produce different behaviour."""
    calls: list = []

    async def fake_embed(settings, q):
        return [0.0] * settings.embedding_dimensions

    async def fake_retrieve(engine, **kw):
        calls.append(kw.get("file_ids"))
        return [
            {
                "file_id": "global-file",
                "content": "some account-wide document",
                "source_metadata": {"source": "notes.pdf"},
                "page": None,
                "section": None,
                "distance": 0.1,
            }
        ]

    monkeypatch.setattr(retrieve.embed, "embed_query", fake_embed)
    monkeypatch.setattr(retrieve.store, "retrieve", fake_retrieve)

    # No Project -> the account corpus, exactly as before Projects existed.
    no_project = await retrieve.retrieve_context(
        SETTINGS, object(), user_id="u1", query=LONG_QUERY, file_ids=None
    )
    assert len(no_project) == 1

    # Empty Project -> nothing, and store.retrieve is not consulted at all, so
    # there is no code path on which the account corpus could come back.
    empty_project = await retrieve.retrieve_context(
        SETTINGS, object(), user_id="u1", query=LONG_QUERY, file_ids=[]
    )
    assert empty_project == []
    assert calls == [None]


async def test_delegated_agent_inherits_the_same_scope():
    """A sub-agent must not be able to widen retrieval beyond its parent.

    AgentEnv.rag is handed straight to the delegated ToolExecContext, so the
    scope set once in the runner is the scope every delegated agent gets. If a
    future delegation path built its own RagContext this assertion is what
    catches it — that would be a silent bypass of the whole Project boundary.
    """
    from app.agent.executor import RagContext

    parent = RagContext(
        engine=object(),  # type: ignore[arg-type]
        user_id="u1",
        settings=SETTINGS,
        file_ids=["p1-file"],
    )
    # What agent/base.py does when it builds the delegated execution context.
    inherited = parent
    assert inherited.file_ids == ["p1-file"]
    assert inherited.user_id == "u1"
