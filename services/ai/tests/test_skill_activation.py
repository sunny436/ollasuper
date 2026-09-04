"""Skill ACTIVATION — the gap between what discovery selects and what the model sees.

Two production failures are pinned here, both found by auditing real threads:

1. Discovery collapsed as the user added detail. `_overlap` divides by the SMALLER
   token set, and a skill's metadata set is large, so the divisor was the query:
   every extra word the user typed pushed the score down. The real 246-char blog
   request scored blog-assist 0.0680 against a 0.2 floor and activated NOTHING,
   while "write a blog about zero trust" scored 0.2833 and activated fine. The
   better the user described the task, the less likely the skill loaded.

2. A selected skill did not necessarily reach the prompt. Bodies range from 278 to
   17,617 chars against a 20,000 budget, so a second substantial skill routinely
   did not fit — and the runner logged what discovery SELECTED, so telemetry
   asserted a skill was active when it never reached the model.
"""

from __future__ import annotations

import pytest

from app.skills.manifest import SkillManifest
from app.skills.registry import SkillRegistry, pack_skills, render_skills_block
from tests.test_skills import _skill

pytestmark = pytest.mark.anyio


def _sk(sid: str, name: str, *, tags, instructions: str, constraints: str = "") -> SkillManifest:
    """Local builder: the shared `_skill` helper carries no constraints, and
    constraints are exactly what compaction has to preserve."""
    return SkillManifest(
        skill_id=sid,
        name=name,
        tags=frozenset(tags),
        instructions=instructions,
        constraints=constraints,
    )


def _blog_registry() -> SkillRegistry:
    return SkillRegistry(
        [
            _skill(
                "blog-assist",
                "Blog Assistant",
                tags=["blog", "article", "content", "writing"],
                purpose="write and improve blog content",
                when="writing or rewriting a blog post",
                instructions="BLOG BODY",
            ),
            _skill(
                "finance",
                "Finance",
                tags=["finance", "valuation", "dcf"],
                purpose="financial modelling",
                instructions="FIN BODY",
            ),
        ]
    )


# --- 1 · discovery must not decay as the request gets more specific -------


def test_a_detailed_request_activates_the_same_skill_as_the_short_one():
    """THE regression: the real prompt, which used to activate nothing."""
    reg = _blog_registry()
    short = "write a blog about zero trust"
    detailed = (
        "Zero Trust in CI/CD Pipelines: Securing Ephemeral Build Runners and "
        "Deployment Nodes\n\ngive me best blog content on above topic in 5000 "
        "words and follow this structure "
        "https://www.quickztna.com/blog/top-10-jit-access-frameworks/\n\n"
        "blog must be human writtten"
    )
    assert "blog-assist" in {a.manifest.skill_id for a in reg.discover(short)}
    assert "blog-assist" in {a.manifest.skill_id for a in reg.discover(detailed)}


def test_the_score_stops_depending_on_request_length():
    """The actual guarantee — and it is NOT that scores never dip.

    Measured: with the intent in its own sentence the score is FLAT at 0.3250
    from 30 to 982 chars. When the intent runs into the following clause it dips
    once (the first segment is now longer) and then PLATEAUS — 0.2607 at every
    length from 148 to 981 chars.

    That is the property worth pinning: the score is bounded below by the best
    single segment and is invariant to total length, so a skill cannot be diluted
    out of existence by a user who keeps typing. The old behaviour decayed to
    0.0680 and stayed there, below the 0.2 floor — dead.
    """
    reg = _blog_registry()
    padding = (
        " The audience is platform engineers. Keep the tone practical with "
        "concrete configuration examples throughout the piece."
    )

    # Intent as its own sentence: completely length-invariant.
    own_sentence = [
        {a.manifest.skill_id: a.score for a in reg.discover(
            "write a blog about zero trust." + padding * n
        )}.get("blog-assist", 0.0)
        for n in range(0, 6)
    ]
    assert len(set(own_sentence)) == 1, f"score varied with length: {own_sentence}"

    # Intent running into the next clause: one dip, then flat — never a decay.
    merged = [
        {a.manifest.skill_id: a.score for a in reg.discover(
            "write a blog about zero trust" + padding * n
        )}.get("blog-assist", 0.0)
        for n in range(1, 6)
    ]
    assert len(set(merged)) == 1, f"score kept decaying with length: {merged}"
    assert all(s > 0.2 for s in merged), f"fell below the activation floor: {merged}"


@pytest.mark.parametrize(
    "request_text",
    [
        "what is the capital of France",
        "hi",
        "thanks, that helped a lot and I appreciate the detail you went into",
        "I was reading about kubernetes yesterday and found it interesting",
        "ok sounds good, talk later",
    ],
)
def test_ordinary_conversation_still_activates_nothing(request_text: str):
    """The fast path is the point: a chat that needs no methodology gets none.

    Segmenting a request creates MORE scoring opportunities, so this is the
    regression that keeps that from turning into false activations.
    """
    assert _blog_registry().discover(request_text) == []


def test_discovery_is_deterministic():
    reg = _blog_registry()
    q = "write a blog about zero trust for platform engineers. Keep it practical."
    first = [(a.manifest.skill_id, a.score) for a in reg.discover(q)]
    for _ in range(3):
        assert [(a.manifest.skill_id, a.score) for a in reg.discover(q)] == first


# --- 2 · what is selected must equal what is rendered --------------------


def test_a_small_skill_behind_a_huge_one_is_still_included():
    """`continue`, not `break`. seo-audit renders 17,617 chars and
    research-methodology 278: stopping at the first skill that does not fit threw
    away every smaller one behind it."""
    huge = _skill("huge", "Huge", tags=["alpha"], instructions="X" * 900)
    medium = _skill("medium", "Medium", tags=["alpha"], instructions="Y" * 900)
    tiny = _skill("tiny", "Tiny", tags=["alpha"], instructions="Z" * 10)
    active = SkillRegistry([huge, medium, tiny]).discover("alpha")
    assert len(active) == 3

    included, _dropped, _compacted = pack_skills(active, char_budget=1200)
    ids = {a.manifest.skill_id for a in included}
    assert "tiny" in ids, "a skill that fits was discarded behind one that did not"


def test_included_and_dropped_partition_the_selection():
    huge = _skill("huge", "Huge", tags=["alpha"], instructions="X" * 900)
    other = _skill("other", "Other", tags=["alpha"], instructions="Y" * 900)
    active = SkillRegistry([huge, other]).discover("alpha")
    included, dropped, _ = pack_skills(active, char_budget=1000)
    assert len(included) + len(dropped) == len(active)
    inc_ids = {a.manifest.skill_id for a in included}
    drop_ids = {a.manifest.skill_id for a in dropped}
    assert not (inc_ids & drop_ids)


def test_what_pack_reports_is_exactly_what_the_block_contains():
    """The telemetry bug: the runner logged the SELECTED set, so a dropped skill
    was reported as active. Every one of the three outcomes is now checkable in
    the rendered text — full carries its procedure, compact carries its rules
    without it, dropped carries nothing."""
    a1 = _sk("keep", "Keep", tags=["alpha"],
             instructions="KEEPBODY" * 60, constraints="KEEPRULES")
    a2 = _sk("drop", "Drop", tags=["alpha"],
             instructions="DROPBODY" * 60, constraints="DROPRULES")
    active = SkillRegistry([a1, a2]).discover("alpha")
    budget = 700
    included, dropped, compacted = pack_skills(active, char_budget=budget)
    block = render_skills_block(active, char_budget=budget)

    compact_ids = {a.manifest.skill_id for a in compacted}
    for a in included:
        assert a.manifest.name in block
        if a.manifest.skill_id in compact_ids:
            # Its procedure gave way; its RULES did not.
            assert a.manifest.instructions[:40] not in block
            assert a.manifest.constraints in block
        else:
            assert a.manifest.instructions[:40] in block
    for a in dropped:
        assert a.manifest.instructions[:40] not in block


def test_a_second_skill_contributes_its_constraints_instead_of_vanishing():
    """Composition, the whole point of item 5: before this, a second substantial
    skill was discarded WHOLE — its safety constraints with it."""
    big = _sk("big", "Big", tags=["alpha"],
              instructions="B" * 900, constraints="BIG-RULES")
    second = _sk("second", "Second", tags=["alpha"],
                 instructions="S" * 900, constraints="SECOND-RULES-MUST-SURVIVE")
    active = SkillRegistry([big, second]).discover("alpha")
    budget = 1100  # one full body fits; two do not
    included, dropped, compacted = pack_skills(active, char_budget=budget)
    block = render_skills_block(active, char_budget=budget)

    assert len(included) == 2, "the second skill was dropped instead of compacted"
    assert len(compacted) == 1
    assert not dropped
    assert "SECOND-RULES-MUST-SURVIVE" in block
    assert len(block) <= budget + 400  # header/footer overhead only


def test_compaction_never_pushes_the_block_over_budget():
    skills = [
        _sk(f"s{i}", f"S{i}", tags=["alpha"], instructions="X" * 900,
            constraints="R" * 200)
        for i in range(6)
    ]
    active = SkillRegistry(skills).discover("alpha", limit=6)
    for budget in (500, 1000, 2000, 4000):
        block = render_skills_block(active, char_budget=budget)
        assert len(block) <= budget + 400, f"budget {budget} overrun: {len(block)}"


def test_nothing_selected_renders_nothing():
    assert render_skills_block([]) == ""
    assert pack_skills([]) == ([], [], [])
