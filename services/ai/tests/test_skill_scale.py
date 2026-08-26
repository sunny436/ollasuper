"""QA-11 — the skill system at future scale (50+ genuinely different domains).

Proves the acceptance directly: discovery is precise (right skill activates, wrong
ones do NOT), composition is bounded, a version bump is recorded while old state
stays readable, and — the load-bearing one — the rendered prompt is bounded by the
ACTIVE skills, NOT by how many are registered. Adding a skill is a `register()`
call; there is no central router to edit (the orchestrator holds no skill-id logic).

SKILL+AGENT and SKILL+DIRECT-TOOL (skill guides an agent that then uses tools) are
proven in test_runtime_e2e.py (test_combined_skill_agent_tools, test_skill_to_tools).
"""

from __future__ import annotations

import time

from app.skills.manifest import ActiveSkill, SkillManifest
from app.skills.registry import (
    DEFAULT_SKILL_BUDGET_CHARS,
    SkillRegistry,
    render_skills_block,
)

# 50 genuinely different domains. Tags (space-separated) are the curated discovery
# anchors (0.7 weight); each domain owns a distinct vocabulary so activation is
# precise, not lexical noise.
_DOMAINS: list[tuple[str, str, str]] = [
    ("cooking", "Home Cooking", "recipe cooking ingredient dinner culinary"),
    ("seo", "SEO Optimization", "seo ranking keyword backlink serp"),
    ("research", "Research Methodology", "research literature sources citation"),
    ("data-analysis", "Data Analysis", "data analyze analysis statistics correlation"),
    ("report", "Report Writing", "report summary writeup deliverable briefing"),
    ("python", "Python Engineering", "python code debug function script"),
    ("legal", "Contract Law", "legal contract clause liability compliance"),
    ("medical", "Clinical Guidance", "medical symptom diagnosis clinical patient"),
    ("finance", "Investing", "finance investment portfolio valuation equity"),
    ("travel", "Trip Planning", "travel itinerary flight hotel destination"),
    ("fitness", "Fitness Coaching", "fitness workout exercise cardio strength"),
    ("music", "Music Theory", "music chord harmony melody scale"),
    ("gardening", "Gardening", "garden plant soil pruning botanical"),
    ("photography", "Photography", "photography camera aperture shutter iso"),
    ("security", "Cybersecurity", "cybersecurity vulnerability exploit malware threat"),
    ("devops", "DevOps", "devops kubernetes deployment container infrastructure"),
    ("ml", "Machine Learning", "neural gradient inference embedding classifier"),
    ("writing", "Creative Writing", "fiction narrative character plot prose"),
    ("translation", "Translation", "translation localization bilingual grammar idiom"),
    ("marketing", "Marketing", "marketing campaign branding funnel conversion"),
    ("accounting", "Accounting", "accounting ledger invoice reconciliation payroll"),
    ("recruiting", "Recruiting", "recruiting candidate hiring resume onboarding"),
    ("realestate", "Real Estate", "property mortgage listing appraisal lease"),
    ("automotive", "Automotive Repair", "automotive engine vehicle transmission"),
    ("astronomy", "Astronomy", "astronomy telescope planet orbit galaxy"),
    ("chemistry", "Chemistry", "chemistry reaction molecule titration catalyst"),
    ("nutrition", "Nutrition", "nutrition calorie diet macronutrient vitamin"),
    ("psychology", "Psychology", "psychology cognition behavior therapy emotion"),
    ("architecture", "Architecture", "architecture blueprint floorplan facade"),
    ("immigration", "Immigration Law", "immigration visa passport citizenship asylum"),
    ("climate", "Climate Science", "climate emissions carbon renewable warming"),
    ("sportscoach", "Sports Coaching", "sports tactics athlete tournament drills"),
    ("gamedesign", "Game Design", "gameplay mechanics level player balancing"),
    ("uxdesign", "UX Design", "ux usability wireframe interaction prototype"),
    ("blockchain", "Blockchain", "blockchain crypto wallet consensus token"),
    ("biology", "Biology", "biology cell dna organism genome"),
    ("history", "History", "history historical empire chronicle archaeology"),
    ("philosophy", "Philosophy", "philosophy ethics logic metaphysics epistemology"),
    ("economics", "Economics", "economics inflation gdp supply demand"),
    ("journalism", "Journalism", "journalism headline byline editorial reporting"),
    ("electrical", "Electrical", "electrical circuit voltage wiring resistor"),
    ("plumbing", "Plumbing", "plumbing pipe drain faucet leak"),
    ("veterinary", "Veterinary", "veterinary canine feline livestock vaccination"),
    ("aviation", "Aviation", "aviation aircraft pilot cockpit runway"),
    ("maritime", "Maritime", "maritime vessel harbor nautical navigation"),
    ("fashion", "Fashion", "fashion garment textile couture wardrobe"),
    ("wine", "Wine Tasting", "wine vineyard sommelier vintage grape"),
    ("meditation", "Meditation", "meditation mindfulness breathing relaxation zen"),
    ("sql", "SQL Databases", "sql database query index join"),
    ("blogging", "Blogging", "blog post audience readership publishing"),
]


def _mk(sid, name, tags, *, version="1.0.0", instructions="Domain guidance body."):
    return SkillManifest(
        skill_id=sid, name=name, version=version,
        purpose=f"{name} methodology", when_to_use=f"when the task concerns {name}",
        tags=frozenset(tags.split()), instructions=instructions,
    )


def _full_registry() -> SkillRegistry:
    return SkillRegistry([_mk(sid, name, tags) for sid, name, tags in _DOMAINS])


def _ids(active: list[ActiveSkill]) -> list[str]:
    return [a.manifest.skill_id for a in active]


# --- DISCOVERY: the right skill activates for unrelated requests -----------
def test_discovery_activates_the_correct_domain():
    reg = _full_registry()
    assert reg.count == 50
    cases = {
        "How do I improve my website's Google search ranking and keywords?": "seo",
        "Give me a recipe for dinner with these ingredients.": "cooking",
        "Analyze this data and find the statistics and correlation.": "data-analysis",
        "Debug my Python function; the code throws.": "python",
        "Write a SQL query to join and index these database tables.": "sql",
        "Plan a travel itinerary with flights and a hotel.": "travel",
        "Explain this immigration visa and citizenship process.": "immigration",
    }
    for req, expected in cases.items():
        active = reg.discover(req)
        assert active, f"no skill activated for: {req!r}"
        assert active[0].manifest.skill_id == expected, (
            f"{req!r} → {_ids(active)}, expected top={expected}"
        )


# --- NON-ACTIVATION: precision, not recall --------------------------------
def test_cooking_request_does_not_activate_seo():
    reg = _full_registry()
    active = _ids(reg.discover("What's a good recipe for dinner tonight?"))
    assert "seo" not in active
    assert "cooking" in active


def test_arithmetic_activates_no_research_skill():
    reg = _full_registry()
    active = _ids(reg.discover("What is 17 times 23?"))
    assert "research" not in active
    # A pure-arithmetic ask matches no domain vocabulary → nothing activates.
    assert active == []


def test_coding_request_does_not_activate_every_skill():
    reg = _full_registry()
    active = _ids(reg.discover("Refactor and debug this Python function."))
    assert "python" in active
    assert len(active) <= 3  # bounded — never "all 50"
    for unrelated in ("cooking", "medical", "legal", "seo", "wine", "astronomy"):
        assert unrelated not in active


# --- MULTI-SKILL COMPOSITION ----------------------------------------------
def test_multi_skill_research_data_report_compose():
    reg = _full_registry()
    active = _ids(reg.discover(
        "Research the sources, analyze the data and statistics, "
        "then write a report summary."
    ))
    for expected in ("research", "data-analysis", "report"):
        assert expected in active, f"{expected} missing from {active}"


# --- SCALE: the prompt is bounded by ACTIVE skills, not REGISTERED ---------
def test_prompt_size_independent_of_registry_size():
    q = "Give me a recipe for dinner and cooking ingredient tips."
    big = _full_registry()                       # 50 skills
    active_big = big.discover(q)
    block_big = render_skills_block(active_big)
    # A registry holding ONLY the activated skills renders the SAME prompt.
    small = SkillRegistry([a.manifest for a in active_big])
    block_small = render_skills_block(small.discover(q))
    assert block_big == block_small, "registering unrelated skills changed the prompt"
    assert len(block_big) <= DEFAULT_SKILL_BUDGET_CHARS
    assert len(active_big) <= 3  # no 50→50 activation


def test_composition_stays_within_budget_even_if_all_match():
    # 40 skills that ALL share one tag → all score, but composition still bounds it.
    reg = SkillRegistry([
        _mk(f"s{i}", f"Skill {i}", "sharedtag", instructions="x" * 4000)
        for i in range(40)
    ])
    block = render_skills_block(reg.discover("sharedtag task"))
    assert len(block) <= DEFAULT_SKILL_BUDGET_CHARS + 200  # +header/frame slack
    assert len(reg.discover("sharedtag task")) <= 3        # discovery caps active


# --- VERSIONING: new workflow records the new version; old state readable --
def test_version_bump_recorded_and_old_state_understandable():
    reg = _full_registry()
    q = "Give me a recipe for dinner."
    v1 = reg.discover(q)[0]
    assert v1.manifest.version == "1.0.0"
    assert "(v1.0.0)" in v1.manifest.render()
    # Bump the SAME skill id to v2 (re-registration replaces the entry).
    reg.register(_mk("cooking", "Home Cooking", _DOMAINS[0][2],
                     version="2.0.0", instructions="Revised method."))
    v2 = reg.discover(q)[0]
    assert v2.manifest.skill_id == "cooking" and v2.manifest.version == "2.0.0"
    assert "(v2.0.0)" in v2.manifest.render()
    # The workflow that recorded v1 still reports v1 — old state stays understandable.
    assert v1.manifest.version == "1.0.0"
    assert "Revised method." not in v1.manifest.render()


# --- MODULARITY: adding a skill is a registration, not a router edit -------
def test_adding_a_skill_needs_no_central_router():
    reg = _full_registry()
    assert reg.discover("How do I fold an origami crane?") == []  # unknown domain
    reg.register(_mk("origami", "Origami", "origami paper fold crease crane"))
    assert reg.count == 51
    active = _ids(reg.discover("How do I fold an origami crane?"))
    assert active == ["origami"]  # discoverable immediately, nothing else touched


# --- SCALE metrics: discovery latency over the full catalogue --------------
def test_discovery_latency_is_flat_over_the_catalogue():
    reg = _full_registry()
    queries = [name for _, name, _ in _DOMAINS] * 4  # 200 lookups
    t0 = time.monotonic()
    total = 0
    for q in queries:
        total += len(reg.discover(q))
    elapsed = time.monotonic() - t0
    assert total > 0
    assert elapsed < 3.0, f"200 discovers over 50 skills took {elapsed:.2f}s"
