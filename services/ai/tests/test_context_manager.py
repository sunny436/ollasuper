"""The platform context layer: classification, resolution, compilation.

Every assertion is on the RESOLVED REFERENCE or the COMPILED BLOCK — never on
model prose. A test that asserts the assistant "did not ask the user to paste the
blog" passes by luck the moment the model changes; a test that asserts the
reference resolved to a specific artifact id and that its text is in the compiled
context cannot.
"""

from __future__ import annotations

import pytest

from app.models.chat import (
    ArtifactRef,
    ConversationContext,
    EntityRef,
    HistoryMessage,
)
from app.runtime.context_manager import (
    ANSWER,
    APPLY_AUDIT,
    AUDIT,
    COMPARE,
    CONTINUE,
    CREATE,
    EXTEND,
    MODIFY,
    REVERT,
    REWRITE,
    RUNG_AMBIGUOUS,
    RUNG_EXPLICIT,
    RUNG_LINEAGE,
    TRANSFORM,
    classify_operation,
    compile_context,
    derive_artifact,
    resolve_reference,
)


def artifact(
    *,
    aid: str,
    version: int = 1,
    kind: str = "blog",
    subject: str = "Cloud WireGuard VPN",
    seq: int = 1,
    status: str = "active",
) -> ArtifactRef:
    return ArtifactRef(
        artifactId=aid,
        version=version,
        kind=kind,
        subject=subject,
        status=status,
        messageId=f"msg_{aid}_{version}",
        seq=seq,
    )


def ctx(**kw) -> ConversationContext:
    return ConversationContext(**kw)


# ------------------------------------------------------------------ operations


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Write a blog about WireGuard", CREATE),
        (
            "give me above blog with more detail explanation and in detail,format",
            MODIFY,
        ),
        ("Make it more detailed", MODIFY),
        ("Add AWS examples", EXTEND),
        ("Make it more human", REWRITE),
        ("Continue", CONTINUE),
        ("continue from where we stopped", CONTINUE),
        ("Turn it into a LinkedIn post", TRANSFORM),
        ("Audit this", AUDIT),
        ("Apply those changes", APPLY_AUDIT),
        ("Go back to the previous version", REVERT),
        ("Compare that with Redis", COMPARE),
        ("What did we decide about security?", ANSWER),
    ],
)
def test_operations_classify_before_any_skill_runs(text: str, expected: str) -> None:
    assert classify_operation(text) == expected


def test_apply_beats_modify_and_revert_beats_continue() -> None:
    """Ordering is load-bearing, not incidental."""
    # "apply the changes" contains no MODIFY verb by accident — but "apply your
    # recommendations and improve it" contains both.
    assert (
        classify_operation("apply your recommendations and improve it") == APPLY_AUDIT
    )
    # "go back to the previous version" would match CONTINUE's "go on" family if
    # REVERT did not come first.
    assert classify_operation("go back to the previous version") == REVERT


# ------------------------------------------------------------------ resolution


def test_bare_reference_resolves_to_the_active_artifact() -> None:
    """The reported failure, at the resolution layer."""
    c = ctx(
        activeArtifactId="art_1",
        activeArtifactVersion=1,
        activeSubject="Cloud WireGuard VPN",
        artifacts=[artifact(aid="art_1", seq=1)],
    )
    r = resolve_reference("give me above blog with more detail explanation", c)
    assert r.resolved
    assert r.artifact_id == "art_1"
    assert r.confidence >= 0.9


def test_a_fresh_create_does_not_hijack_prior_work() -> None:
    """No marker, no named subject, no kind word ⇒ nothing to resolve.

    Without this, "write a blog about Kubernetes" silently becomes an edit of the
    WireGuard article — the failure mode opposite to the reported one, and worse,
    because it destroys work instead of asking for it.
    """
    c = ctx(
        activeArtifactId="art_1",
        artifacts=[artifact(aid="art_1", seq=1)],
    )
    r = resolve_reference("Write a detailed guide to Kubernetes networking", c)
    assert not r.resolved


def test_explicit_subject_outranks_the_active_artifact() -> None:
    """Rung 1 beats rung 2: naming a subject means that subject."""
    c = ctx(
        activeArtifactId="art_redis",
        activeSubject="Redis",
        artifacts=[
            artifact(aid="art_pg", subject="PostgreSQL", seq=1),
            artifact(aid="art_redis", subject="Redis", seq=2),
        ],
    )
    r = resolve_reference("expand the PostgreSQL article", c)
    assert r.artifact_id == "art_pg"
    assert r.rung == RUNG_EXPLICIT


def test_previous_version_walks_the_lineage_not_the_transcript() -> None:
    """ "Previous version" means the previous VERSION.

    Two artifacts produced in consecutive turns make "the previous one" ambiguous
    with "the message before"; only the supersedes chain distinguishes them.
    """
    c = ctx(
        activeArtifactId="art_1",
        activeArtifactVersion=3,
        artifacts=[
            artifact(aid="art_1", version=1, seq=1, status="superseded"),
            artifact(aid="art_1", version=2, seq=3, status="superseded"),
            artifact(aid="art_1", version=3, seq=5, status="active"),
        ],
    )
    r = resolve_reference("go back to the previous version", c)
    assert r.artifact_id == "art_1"
    assert r.version == 2
    assert r.rung == RUNG_LINEAGE


def test_explicit_version_is_honoured() -> None:
    c = ctx(
        activeArtifactId="art_1",
        artifacts=[
            artifact(aid="art_1", version=1, seq=1, status="superseded"),
            artifact(aid="art_1", version=2, seq=3, status="active"),
        ],
    )
    r = resolve_reference("restore v1", c)
    assert r.version == 1


def test_entity_activation_order_beats_mention_recency() -> None:
    """PostgreSQL -> Redis -> "go back to PostgreSQL" -> "compare that with Redis".

    `that` must be PostgreSQL. Mention-recency says Redis, because Redis is named
    right there in the sentence — which is exactly why the referent is tracked by
    ACTIVATION rather than by the last time a word appeared.
    """
    c = ctx(
        # PostgreSQL was re-activated at seq 5 by the user going back to it.
        activeArtifactId="art_pg",
        activeSubject="PostgreSQL",
        entities=[
            EntityRef(name="PostgreSQL", activatedAtSeq=5),
            EntityRef(name="Redis", activatedAtSeq=3),
        ],
        artifacts=[
            artifact(aid="art_pg", subject="PostgreSQL", kind="report", seq=1),
            artifact(aid="art_redis", subject="Redis", kind="report", seq=3),
        ],
    )
    r = resolve_reference("compare that with Redis", c)
    assert r.artifact_id == "art_pg", (
        "the comparand named in the sentence was mistaken for the referent"
    )


def test_two_equally_recent_candidates_are_reported_ambiguous() -> None:
    """The only case that should ever cost a clarifying question."""
    c = ctx(
        artifacts=[
            artifact(aid="art_a", subject="Alpha", seq=4),
            artifact(aid="art_b", subject="Beta", seq=4),
        ],
    )
    r = resolve_reference("make it longer", c)
    assert not r.resolved
    assert r.rung == RUNG_AMBIGUOUS
    assert set(r.candidates) == {"art_a", "art_b"}


def test_section_reference_is_captured() -> None:
    c = ctx(
        activeArtifactId="art_1",
        artifacts=[artifact(aid="art_1", seq=1)],
    )
    assert resolve_reference("rewrite the security section", c).section == "security"
    assert resolve_reference("expand section 3", c).section == "3"


# ----------------------------------------------------------------- compilation


def test_the_resolved_artifact_is_pinned_into_the_block() -> None:
    """The whole point: the text is IN the context, so nothing has to ask for it."""
    body = "THE-BLOG " + "x" * 20_000
    c = ctx(
        activeArtifactId="art_1",
        activeArtifactVersion=1,
        activeSubject="Cloud WireGuard VPN",
        artifacts=[artifact(aid="art_1", seq=1)],
    )
    compiled = compile_context(
        user_text=(
            "give me above blog with more detail explanation and in detail,format"
        ),
        ctx=c,
        history=[HistoryMessage(role="assistant", content=body, seq=1)],
        artifact_reserve_tokens=8_000,
    )
    assert compiled is not None
    assert compiled.operation == MODIFY
    assert compiled.resolution.artifact_id == "art_1"
    assert compiled.pinned_artifact_id == "art_1"
    assert "THE-BLOG" in compiled.block
    assert "do not ask" in compiled.block.lower()


def test_pinned_artifact_is_clipped_to_its_TOKEN_reserve() -> None:
    """A reserve in tokens, not characters.

    Characters are not tokens and the ratio swings by ~3x between prose and code,
    so a character cap cannot enforce a window. The reserve is measured.
    """
    body = "START " + ("lorem ipsum dolor sit amet " * 8_000) + " END"
    c = ctx(
        activeArtifactId="art_1",
        artifacts=[artifact(aid="art_1", seq=1)],
    )
    compiled = compile_context(
        user_text="expand it",
        ctx=c,
        history=[HistoryMessage(role="assistant", content=body, seq=1)],
        artifact_reserve_tokens=1_000,
    )
    assert compiled is not None
    assert compiled.pinned_clipped is True
    assert compiled.pinned_tokens <= 1_000
    # Head AND tail survive: the end of a document is what an expand continues.
    assert "START" in compiled.block
    assert "END" in compiled.block


def test_out_of_window_artifact_still_reaches_the_model() -> None:
    """The long-conversation case.

    The artifact aged out of the history window forty turns ago. Convex attaches
    its text for exactly this reason, so a reference to it still resolves to
    something retrievable rather than to a promise the model cannot keep.
    """
    c = ctx(
        activeArtifactId="art_1",
        activeArtifactVersion=1,
        artifacts=[artifact(aid="art_1", seq=1)],
        activeArtifactText="ANCIENT-ARTICLE body text",
    )
    compiled = compile_context(
        user_text="expand the above article",
        ctx=c,
        history=[HistoryMessage(role="user", content="expand it", seq=99)],
        artifact_reserve_tokens=4_000,
    )
    assert compiled is not None
    assert "ANCIENT-ARTICLE" in compiled.block


def test_constraints_are_carried_forward_on_a_narrow_edit() -> None:
    """ "Make it more human" must not discard technical accuracy or SEO intent."""
    c = ctx(
        activeArtifactId="art_1",
        artifacts=[artifact(aid="art_1", seq=1)],
        userConstraints=[
            "technically accurate",
            "SEO-friendly",
            "publish-ready",
        ],
    )
    compiled = compile_context(
        user_text="make it more human",
        ctx=c,
        history=[HistoryMessage(role="assistant", content="body", seq=1)],
        artifact_reserve_tokens=2_000,
    )
    assert compiled is not None
    assert compiled.operation == REWRITE
    for constraint in ("technically accurate", "SEO-friendly", "publish-ready"):
        assert constraint in compiled.block
    assert "carry these forward" in compiled.block


def test_no_state_means_no_block_at_all() -> None:
    """A first turn must be byte-identical to life before this layer."""
    assert (
        compile_context(
            user_text="Write a blog about WireGuard",
            ctx=ctx(),
            history=[],
            artifact_reserve_tokens=4_000,
        )
        is None
    )
    assert (
        compile_context(
            user_text="hello",
            ctx=None,
            history=[],
            artifact_reserve_tokens=4_000,
        )
        is None
    )


def test_the_floor_does_not_read_model_supplied_fields() -> None:
    """Resolution must work with zero enrichment.

    A model that never calls record_context leaves constraints and decisions
    empty. Nothing in the resolution path may depend on them.
    """
    c = ctx(
        activeArtifactId="art_1",
        activeArtifactVersion=2,
        activeSubject="Cloud WireGuard VPN",
        artifacts=[
            artifact(aid="art_1", version=1, seq=1, status="superseded"),
            artifact(aid="art_1", version=2, seq=3, status="active"),
        ],
        userConstraints=[],
        userDecisions=[],
        openLoops=[],
    )
    r = resolve_reference("make the above blog more detailed", c)
    assert r.resolved
    assert r.artifact_id == "art_1"
    assert r.version == 2


# ------------------------------------------------------------ artifact floor


def _blog_with_config(n_blocks: int = 4) -> str:
    """A technical article: mostly prose, with configuration examples."""
    prose = "WireGuard is a modern VPN. " * 60
    block = "```ini\n[Interface]\nPrivateKey = abc\n```\n"
    body = "# Cloud WireGuard VPN\n\n" + prose
    for i in range(n_blocks):
        body += f"\n\n## Section {i}\n\n" + prose + "\n\n" + block
    return body


def test_a_technical_article_with_config_blocks_is_not_code() -> None:
    """The defect production actually produced.

    The WireGuard blog has several fenced blocks and was registered as
    kind="code", which then made "the article" fail to match it by kind.
    Counting fences is the wrong signal; how much of the text is inside them is
    the right one.
    """
    d = derive_artifact(
        operation=CREATE,
        final_text=_blog_with_config(),
        ctx=None,
        resolution=None,
        fallback_subject="fallback",
    )
    assert d is not None
    assert d.kind == "blog"
    assert d.subject == "Cloud WireGuard VPN"


def test_a_predominantly_code_answer_is_code() -> None:
    body = "Here you go:\n\n```python\n" + ("x = 1\n" * 400) + "```\n"
    d = derive_artifact(
        operation=CREATE,
        final_text=body,
        ctx=None,
        resolution=None,
        fallback_subject="a script",
    )
    assert d is not None
    assert d.kind == "code"


def test_a_short_answer_is_not_an_artifact() -> None:
    """Registering every reply would make "it" ambiguous on every turn."""
    assert (
        derive_artifact(
            operation=ANSWER,
            final_text="Yes, that is correct.",
            ctx=None,
            resolution=None,
            fallback_subject="x",
        )
        is None
    )


def test_an_audit_is_about_an_artifact_not_a_version_of_one() -> None:
    """Otherwise "apply those changes" resolves to the audit, not to the work."""
    assert (
        derive_artifact(
            operation=AUDIT,
            final_text="# Findings\n\n" + ("Issue found. " * 400),
            ctx=None,
            resolution=None,
            fallback_subject="x",
        )
        is None
    )


def test_a_modify_supersedes_and_keeps_the_original_identity() -> None:
    """ "Make it more human" must not rename the article after the new heading."""
    c = ctx(
        activeArtifactId="art_1",
        artifacts=[
            artifact(aid="art_1", kind="blog", subject="Cloud WireGuard VPN", seq=1)
        ],
    )
    resolution = resolve_reference("make it more human", c)
    d = derive_artifact(
        operation=REWRITE,
        final_text="# A Totally Different Heading\n\n" + ("prose " * 400),
        ctx=c,
        resolution=resolution,
        fallback_subject="ignored",
    )
    assert d is not None
    assert d.supersedes_artifact_id == "art_1"
    assert d.subject == "Cloud WireGuard VPN"
    assert d.kind == "blog"
