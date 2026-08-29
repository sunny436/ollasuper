"""Documents capability — autonomous jargon-free routing + flag-gated registration.
The router must activate on plain-language presentation/PDF requests, add NO delegated
agent, never hijack the siblings, and be byte-identical when off."""

from __future__ import annotations

from app.runtime.roster import (
    PRODUCTION_AGENTS,
    PRODUCTION_SKILLS,
    build_delegate_spec,
    effective_agents,
    effective_skills,
)
from app.skills.registry import SkillRegistry
from tests.conftest import make_settings


def _on(**extra):
    return make_settings("http://x", ai_documents_enabled=True, **extra)


def _off():
    return make_settings("http://x", ai_documents_enabled=False)


def _roles(settings):
    return build_delegate_spec(settings)["function"]["parameters"]["properties"][
        "role"
    ]["enum"]


def test_flag_off_roster_unchanged():
    assert effective_agents(_off()) == PRODUCTION_AGENTS
    assert effective_skills(_off()) == PRODUCTION_SKILLS
    assert "documents" not in _roles(_off())


def test_flag_on_adds_one_skill_no_agent():
    agents, skills = effective_agents(_on()), effective_skills(_on())
    assert agents == list(PRODUCTION_AGENTS)
    assert [s.skill_id for s in skills].count("documents") == 1
    assert len(skills) == len(PRODUCTION_SKILLS) + 1
    assert "documents" not in _roles(_on())


def _top(q, settings=None):
    t = SkillRegistry(effective_skills(settings or _on())).discover(q)
    return t[0].manifest.skill_id if t else None


def test_plain_language_routes_to_documents():
    cases = {
        "deck": "make a pitch deck",
        "investor": "create an investor presentation",
        "report_to_deck": "turn this report into a presentation",
        "fix": "fix this ppt",
        "add": "add three slides",
        "analyze": "analyze this presentation",
        "template": "use this template",
        "professional": "make this deck look professional",
        "to_pdf": "convert these slides into a PDF",
        "pdf_report": "create a PDF report",
        "read_pdf": "read this PDF",
        "tables": "extract the tables",
        "ocr": "OCR this scanned PDF",
        "merge": "merge these PDFs",
        "split": "split pages 5-10",
        "fill": "fill this PDF form",
        "fillable": "create a fillable PDF",
        "show_pdf": "show me the PDF here",
        "show_slides": "show me the slides here",
        "duplicate": "duplicate slide 2",
    }
    for name, q in cases.items():
        assert _top(q) == "documents", f"{name}: {q!r} -> {_top(q)}"


def test_documents_does_not_hijack_siblings():
    s = _on(
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
        ai_data_analysis_enabled=True,
        ai_sales_enabled=True,
        ai_hr_enabled=True,
        ai_finance_enabled=True,
        ai_marketing_enabled=True,
        ai_operations_enabled=True,
    )

    def top(q):
        t = SkillRegistry(effective_skills(s)).discover(q)
        return t[0].manifest.skill_id if t else None

    assert top("create a financial forecast") == "finance"
    assert top("analyze employee attrition") == "hr"
    assert top("analyze our sales pipeline and forecast quota") == "sales"
    assert top("analyze this csv") == "data-analysis"
    assert top("write a blog post about slides") == "blog-assist"
    assert top("research pptx best practices deeply with sources") == "deep-research"
    assert top("create a go-to-market strategy") == "marketing"
    assert top("evaluate this vendor proposal") == "operations"
    assert top("audit example.com technical seo") == "seo-audit"


def test_flag_off_never_activates():
    t = SkillRegistry(effective_skills(_off())).discover(
        "make a pitch deck and read this PDF"
    )
    assert "documents" not in {a.manifest.skill_id for a in t}


def test_documents_coexists_with_all_flags_on():
    s = _on(
        ai_seo_enabled=True,
        ai_blog_enabled=True,
        ai_research_enabled=True,
        ai_data_analysis_enabled=True,
        ai_sales_enabled=True,
        ai_hr_enabled=True,
        ai_finance_enabled=True,
        ai_marketing_enabled=True,
        ai_operations_enabled=True,
    )
    reg = SkillRegistry(effective_skills(s))
    assert reg.discover("make a pitch deck")[0].manifest.skill_id == "documents"
    assert (
        reg.discover("audit example.com technical seo")[0].manifest.skill_id
        == "seo-audit"
    )
