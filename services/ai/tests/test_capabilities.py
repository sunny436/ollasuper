"""Dynamic capability self-awareness — the overview is DERIVED from the enabled
skills + flags + context, not a hardcoded list. Hermetic; no network."""

from __future__ import annotations

from app.runtime.capabilities import render_capability_overview
from app.runtime.roster import effective_skills
from app.skills.manifest import SkillManifest
from tests.conftest import make_settings


def _prod_settings(**over):
    base = dict(
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
        ai_data_analysis_enabled=True,
        ai_file_generation_enabled=True,
        ai_agent_memory_tool_enabled=True,
        ai_agent_rag_tool_enabled=True,
        # make settings.agent_enabled True (flag + ollagraph configured)
        ai_agent_enabled=True,
        ollagraph_base_url="http://ollagraph.test",
        ollagraph_api_key="osk-test",
    )
    base.update(over)
    return make_settings("http://x", **base)


def _overview(settings, **ctx):
    return render_capability_overview(effective_skills(settings), settings, **ctx)


# --- Test 1: current capabilities reflect the actual registered state -------
def test_overview_reflects_enabled_skills_and_platform():
    o = _overview(
        _prod_settings(), has_datasets=False, has_files=True, memory_enabled=True
    )
    assert "SEO" in o  # seo-audit
    assert "Blog Assistant" in o
    assert "Deep Research" in o
    assert "Data Analysis" in o
    # platform capabilities are flag-derived
    assert "Search the web" in o  # agent_enabled
    assert "downloadable files" in o.lower()  # file generation
    assert "charts" in o.lower()  # visualization (always)
    assert "Remember your preferences" in o  # memory (enabled + on)
    assert "uploaded documents / knowledge base" in o  # rag + has_files
    # grouped by category
    assert "- Research:" in o and "- Data & Analytics:" in o


# --- Test 2: a NEW skill is auto-discovered with no other change ------------
def test_new_skill_is_discovered_dynamically():
    mock = SkillManifest(
        skill_id="widget-maker",
        name="Widget Maker",
        purpose="design and produce custom widgets",
        metadata={"category": "Manufacturing"},
    )
    skills = effective_skills(_prod_settings()) + [mock]
    o = render_capability_overview(skills, _prod_settings())
    assert "Widget Maker: design and produce custom widgets" in o
    assert "- Manufacturing:" in o  # its self-declared category appears


# --- Test 3: a disabled skill is NOT claimed --------------------------------
def test_disabled_skill_absent():
    off = _prod_settings(ai_seo_enabled=False)
    o = _overview(off)
    assert "SEO" not in o
    # the others remain
    assert "Blog Assistant" in o and "Data Analysis" in o


# --- Test 4: unavailable platform capabilities are NOT claimed --------------
def test_disabled_platform_capabilities_absent():
    o = _overview(
        _prod_settings(ai_file_generation_enabled=False, ai_agent_enabled=False)
    )
    assert "downloadable files" not in o.lower()  # file gen off
    assert "Search the web" not in o  # agent/web off
    # data-analysis compute OFF => the generic skill stays but WITHOUT the file claim
    o2 = _overview(_prod_settings(ai_data_analysis_enabled=False))
    assert "attach a CSV" not in o2 and "dataset is attached" not in o2


# --- Test 5: contextual capability distinguishes available-now --------------
def test_data_analysis_contextual_note():
    with_ds = _overview(_prod_settings(), has_datasets=True)
    without = _overview(_prod_settings(), has_datasets=False)
    assert "a dataset is attached — I can analyze it now" in with_ds
    assert "attach a CSV/Excel file" in without


# --- Test 6: existing skills all discoverable when enabled ------------------
def test_all_product_skills_present():
    o = _overview(_prod_settings())
    for name in ("SEO", "Blog Assistant", "Deep Research", "Data Analysis"):
        assert name in o, name


# --- guard: no internal implementation details leak -------------------------
def test_no_internal_details_leak():
    o = _overview(_prod_settings(), has_datasets=True, has_files=True).lower()
    bad_tokens = (
        "skill_id",
        "ai_seo_enabled",
        "ai_data_analysis_enabled",
        ".py",
        "_endpoint",
        "storageid",
    )
    for bad in bad_tokens:
        assert bad not in o, bad


def test_empty_when_nothing_enabled():
    # a bare box: no agent, no skills beyond generic, no platform tools => still lists
    # the always-on Files + Visualization, but never crashes.
    bare = make_settings("http://x")
    o = render_capability_overview([], bare)
    assert "<your_capabilities>" in o and "charts" in o.lower()


# --- catalogue: the ids the Explore menu offers ------------------------------
#
# The catalogue is derived separately from render_capability_overview rather than
# sharing its code, deliberately: the overview is injected into the system prompt
# of every agentic turn, and refactoring it to serve a dropdown would put the one
# thing that can change generation on the critical path of a UI feature. These
# tests are what buys the same guarantee — they pin the two in agreement.


def _catalog(settings):
    from app.runtime.capabilities import capability_catalog

    return capability_catalog(settings)


def test_catalogue_offers_every_flag_gated_capability_when_all_are_on():
    ids = _catalog(
        _prod_settings(
            ai_finance_enabled=True,
            ai_sales_enabled=True,
            ai_hr_enabled=True,
            ai_marketing_enabled=True,
            ai_operations_enabled=True,
            ai_documents_enabled=True,
        )
    )
    assert set(ids) == {
        "finance",
        "sales",
        "marketing",
        "hr",
        "ops",
        "coding",
        "data",
        "seo",
        "web",
        "research",
        "writing",
        "docs",
        "files",
    }


def test_finance_is_ONE_entry_despite_registering_two_skills():
    """roster.py appends FINANCE_SKILL *and* EQUITY_SKILL behind one flag.

    A skill-per-menu-item mapping would show Finance twice; a user picking
    "Finance" is choosing a subject area, not a manifest.
    """
    settings = _prod_settings(ai_finance_enabled=True)
    skills = effective_skills(settings)
    finance_skills = [
        s for s in skills if "equity" in s.skill_id or "finance" in s.skill_id
    ]
    assert len(finance_skills) >= 2, (
        "precondition: finance really does register two skills"
    )
    assert _catalog(settings).count("finance") == 1


def test_clearing_a_flag_removes_exactly_that_capability():
    on = set(_catalog(_prod_settings(ai_documents_enabled=True, ai_sales_enabled=True)))
    off = set(
        _catalog(_prod_settings(ai_documents_enabled=False, ai_sales_enabled=True))
    )
    assert on - off == {"docs"}


def test_ungated_capabilities_survive_a_bare_deployment():
    """Coding, writing, research and file analysis are base skills or
    unconditional platform behaviour — a deployment with every flag off still
    has them, and the menu must still offer them."""
    ids = set(_catalog(make_settings("http://x")))
    assert {"coding", "writing", "research", "data", "files"} <= ids
    # ...and nothing flag-gated leaked in.
    assert not ({"finance", "sales", "hr", "marketing", "ops", "docs", "seo"} & ids)


def test_catalogue_and_overview_agree_on_what_is_live():
    """The property the shared-code refactor would have given us, asserted
    instead. If a flag makes the overview advertise something, the menu offers
    it; if it does not, the menu must not."""
    for flag, cap_id, needle in [
        ("ai_seo_enabled", "seo", "SEO"),
        ("ai_documents_enabled", "docs", "Document"),
        ("ai_sales_enabled", "sales", "Sales"),
        ("ai_finance_enabled", "finance", "Financ"),
    ]:
        enabled = _prod_settings(**{flag: True})
        disabled = _prod_settings(**{flag: False})
        assert cap_id in _catalog(enabled)
        assert needle in _overview(enabled), f"{needle} missing from overview"
        assert cap_id not in _catalog(disabled)
        assert needle not in _overview(disabled), f"{needle} still claimed when off"
