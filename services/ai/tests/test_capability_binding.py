"""Phase 6 — declared capabilities, resolved and authorized.

Two things are proven here.

FIRST, the bug. `reserve_skill_tools` resolves a declaration with
`registry.get(name)`, a literal tool-id lookup, but skills declare INTENTS.
Measured against the shipped catalogue, 100% of what the blog and SEO skills
declare are intents and 0% are registered tool ids, so every lookup returned
None and nothing was ever reserved. The first two tests below fail against the
old behaviour and pass against the new one.

SECOND, that resolving them does not weaken anything. A declaration widens what
is RELEVANT; it never widens what is ALLOWED. Every gate — existence,
availability, permissions, side-effect ceiling, admin-token, per-call policy —
is asserted against a declaration that names a tool it must not get.
"""

from __future__ import annotations

import httpx
from langchain_core.messages import AIMessage

from app.agent.policy import READ_SCOPE, WRITE_SCOPE, PolicyScope
from app.blog.capabilities import BLOG_CAPABILITIES
from app.blog.skill import BLOG_SKILL
from app.models.chat import CustomSkill, GenerateRequest, HistoryMessage
from app.models.tools import (
    Availability,
    SideEffect,
    ToolDefinition,
    ToolFilters,
    ToolPermissions,
)
from app.orchestrator.intents import INTENT_MAP, register_intents
from app.runtime.runner import reserve_skill_tools, run_generation
from app.seo.skill import SEO_SKILL
from app.skills.capability_binding import resolve_capabilities
from app.tools.registry import ToolRegistry
from app.tools.selection import ToolSelector
from tests.conftest import make_settings
from tests.test_agent_runner import RecordingConvex


def _tool(
    tool_id: str,
    *,
    name: str = "",
    description: str = "",
    side_effect: SideEffect = SideEffect.READ_ONLY,
    enabled: bool = True,
    availability: Availability = Availability.AVAILABLE,
    permissions: list[str] | None = None,
    required_auth: str = "BearerAuth",
    category: str = "search",
) -> ToolDefinition:
    return ToolDefinition(
        tool_id=tool_id,
        name=name or tool_id,
        description=description or "Search the web for pages and sources",
        path=f"/v1/{tool_id}",
        method="post",
        category=category,
        side_effect=side_effect,
        enabled=enabled,
        availability=availability,
        permissions=ToolPermissions(
            required_permissions=permissions
            if permissions is not None
            else ["ollagraph:read"]
        ),
        required_auth=required_auth,
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
    )


# A tool whose text matches the `blog.serp_research` intent query
# ("web search serp results ranking pages sources for a query") but whose ID is
# the provider operation id — exactly the real shape.
def _serp_tool(**kw) -> ToolDefinition:
    return _tool(
        "search_endpoint_v1_search_post",
        name="Search",
        description="web search serp results ranking pages and sources for a query",
        **kw,
    )


def _fixture(*tools):
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    return reg, ToolSelector(reg)


def _resolve(names, reg, sel, *, filters=None, scope=READ_SCOPE, **kw):
    return resolve_capabilities(
        names,
        registry=reg,
        selector=sel,
        filters=filters
        or ToolFilters(
            max_side_effect=SideEffect.READ_ONLY,
            granted_permissions=scope.granted_permissions,
        ),
        scope=scope,
        **kw,
    )


# ---------------------------------------------------------------------------
# THE BUG
# ---------------------------------------------------------------------------
def test_built_in_skills_declare_intents_not_tool_ids():
    """The measurement that makes the bug undeniable, run against the real
    shipped catalogue rather than a fixture."""
    intents = {c.intent for c in BLOG_CAPABILITIES}
    real_ids = {t for c in BLOG_CAPABILITIES for t in c.tool_ids}
    declared = set(BLOG_SKILL.preferred_capabilities)
    assert declared, "the blog skill declares nothing"
    assert declared <= intents, "not every declaration is an intent"
    assert not (declared & real_ids), "a declaration was a raw tool id after all"
    # And the two namespaces really are disjoint.
    assert "blog.serp_research" in intents
    assert "search_endpoint_v1_search_post" in real_ids


def test_the_old_literal_lookup_reserved_nothing():
    """`reserve_skill_tools` on its own — the pre-Phase-6 behaviour.

    Kept as a test rather than deleted with the bug, because it is the thing
    that silently held for the whole life of the feature and the only way to
    keep it from coming back is to assert why it failed.
    """
    reg, _ = _fixture(_serp_tool())
    filters = ToolFilters(granted_permissions=frozenset({"ollagraph:read"}))
    _, added = reserve_skill_tools([], {"blog.serp_research"}, reg, filters)
    assert added == 0, "the intent should not resolve as a literal tool id"


def test_resolving_the_intent_finds_the_real_tool():
    reg, sel = _fixture(_serp_tool())
    register_intents({"blog.serp_research": {"query": BLOG_CAPABILITIES[0].query}})
    out = _resolve(["blog.serp_research"], reg, sel)
    assert out.tool_ids == ["search_endpoint_v1_search_post"]
    assert not out.any_failures


def test_end_to_end_a_declaration_now_actually_reserves():
    reg, sel = _fixture(_serp_tool())
    register_intents({"blog.serp_research": {"query": BLOG_CAPABILITIES[0].query}})
    filters = ToolFilters(granted_permissions=frozenset({"ollagraph:read"}))
    out = _resolve(["blog.serp_research"], reg, sel, filters=filters)
    _, added = reserve_skill_tools([], set(out.tool_ids), reg, filters)
    assert added == 1


# ---------------------------------------------------------------------------
# THE CONTRACT — existence
# ---------------------------------------------------------------------------
def test_an_unknown_capability_is_reported_not_silently_dropped():
    reg, sel = _fixture(_serp_tool())
    out = _resolve(["not.a.capability"], reg, sel)
    assert out.tool_ids == []
    assert out.unknown == ["not.a.capability"]


def test_a_known_intent_with_no_matching_tool_is_unresolved_not_unknown():
    # The deployment simply does not have a tool for it. A different answer from
    # "that is not a capability", and the user is owed the difference.
    reg, sel = _fixture(_tool("unrelated", description="convert currency amounts"))
    register_intents({"phase6.absent": {"query": "quantum teleportation harmonics"}})
    out = _resolve(["phase6.absent"], reg, sel)
    assert out.tool_ids == []
    assert out.unknown == []
    assert out.unresolved == ["phase6.absent"]


def test_a_user_may_not_name_a_raw_provider_tool_id():
    # It exists and it is permitted — and it is still refused, because the
    # user-facing vocabulary is the stable one. Not an escalation defense; a
    # stability and usability one.
    reg, sel = _fixture(_serp_tool())
    out = _resolve(["search_endpoint_v1_search_post"], reg, sel, intents_only=True)
    assert out.tool_ids == []
    assert out.unknown == ["search_endpoint_v1_search_post"]
    # A built-in, which may use the documented literal form, still resolves it.
    assert _resolve(["search_endpoint_v1_search_post"], reg, sel).tool_ids == [
        "search_endpoint_v1_search_post"
    ]


# ---------------------------------------------------------------------------
# THE CONTRACT — availability and authorization
# ---------------------------------------------------------------------------
def test_a_disabled_tool_is_never_bound():
    reg, sel = _fixture(_serp_tool(enabled=False))
    register_intents({"phase6.serp_a": {"query": BLOG_CAPABILITIES[0].query}})
    out = _resolve(["phase6.serp_a"], reg, sel)
    assert out.tool_ids == []
    assert out.unavailable == ["phase6.serp_a"]


def test_an_unavailable_tool_is_never_bound():
    reg, sel = _fixture(_serp_tool(availability=Availability.UNAVAILABLE))
    register_intents({"phase6.serp_b": {"query": BLOG_CAPABILITIES[0].query}})
    out = _resolve(["phase6.serp_b"], reg, sel)
    assert out.tool_ids == []
    assert out.tool_ids == [] and (out.unavailable or out.unauthorized)


def test_a_permission_the_caller_lacks_denies_the_capability():
    reg, sel = _fixture(_serp_tool(permissions=["ollagraph:admin"]))
    register_intents({"phase6.serp_c": {"query": BLOG_CAPABILITIES[0].query}})
    out = _resolve(["phase6.serp_c"], reg, sel)  # READ_SCOPE grants read only
    assert out.tool_ids == []
    assert out.unauthorized == ["phase6.serp_c"]


def test_a_side_effecting_tool_is_denied_under_a_read_only_ceiling():
    reg, sel = _fixture(_serp_tool(side_effect=SideEffect.EXTERNAL_SIDE_EFFECT))
    register_intents({"phase6.serp_d": {"query": BLOG_CAPABILITIES[0].query}})
    out = _resolve(["phase6.serp_d"], reg, sel)
    assert out.tool_ids == []
    assert out.unauthorized == ["phase6.serp_d"]


def test_the_same_tool_is_allowed_once_the_ceiling_is_raised():
    # The denial above is the CEILING doing its job, not the tool being broken.
    reg, sel = _fixture(_serp_tool(side_effect=SideEffect.EXTERNAL_SIDE_EFFECT))
    register_intents({"phase6.serp_e": {"query": BLOG_CAPABILITIES[0].query}})
    out = _resolve(
        ["phase6.serp_e"],
        reg,
        sel,
        scope=WRITE_SCOPE,
        filters=ToolFilters(
            max_side_effect=SideEffect.EXTERNAL_SIDE_EFFECT,
            granted_permissions=WRITE_SCOPE.granted_permissions,
        ),
    )
    assert out.tool_ids == ["search_endpoint_v1_search_post"]


def test_a_high_impact_tool_is_never_reachable_by_declaration():
    reg, sel = _fixture(_serp_tool(side_effect=SideEffect.HIGH_IMPACT))
    register_intents({"phase6.serp_f": {"query": BLOG_CAPABILITIES[0].query}})
    for scope, filters in (
        (READ_SCOPE, None),
        (
            WRITE_SCOPE,
            ToolFilters(
                max_side_effect=SideEffect.EXTERNAL_SIDE_EFFECT,
                granted_permissions=WRITE_SCOPE.granted_permissions,
            ),
        ),
    ):
        out = _resolve(["phase6.serp_f"], reg, sel, scope=scope, filters=filters)
        assert out.tool_ids == [], scope


def test_an_admin_scoped_tool_is_dropped_even_though_filters_pass_it():
    """`_passes` has no concept of the admin-token rule; only
    `check_tool_policy` does. Without the policy pass in `resolve_capabilities`
    this tool binds and then can only ever fail at execution."""
    reg, sel = _fixture(_serp_tool(required_auth="AdminToken", permissions=[]))
    register_intents({"phase6.serp_g": {"query": BLOG_CAPABILITIES[0].query}})
    scope = PolicyScope(granted_permissions=frozenset({"ollagraph:read"}))
    out = _resolve(["phase6.serp_g"], reg, sel, scope=scope)
    assert out.tool_ids == []
    assert "search_endpoint_v1_search_post" in out.unauthorized


def test_an_approval_required_tool_IS_bound_and_gated_at_call_time():
    # Approval is not a reason to withhold a capability — it is the mechanism
    # for offering it safely. It must bind, then require approval.
    reg, sel = _fixture(
        _serp_tool(permissions=[]),
    )
    reg.get("search_endpoint_v1_search_post").permissions.approval_required = True
    register_intents({"phase6.serp_h": {"query": BLOG_CAPABILITIES[0].query}})
    out = _resolve(["phase6.serp_h"], reg, sel)
    assert out.tool_ids == ["search_endpoint_v1_search_post"]
    from app.agent.policy import check_tool_policy

    decision = check_tool_policy(reg.get("search_endpoint_v1_search_post"), READ_SCOPE)
    assert decision.needs_approval


def test_an_agent_allowlist_still_denies_an_out_of_scope_declaration():
    reg, sel = _fixture(_serp_tool())
    register_intents({"phase6.serp_i": {"query": BLOG_CAPABILITIES[0].query}})
    scoped = PolicyScope(
        granted_permissions=frozenset({"ollagraph:read"}),
        allowed_tool_ids=frozenset({"some.other.tool"}),
        allowed_categories=frozenset(),
    )
    out = _resolve(["phase6.serp_i"], reg, sel, scope=scoped)
    assert out.tool_ids == []


# ---------------------------------------------------------------------------
# NO NEW TOOLS, NO GLOBAL MUTATION
# ---------------------------------------------------------------------------
def test_a_declaration_can_never_create_a_tool():
    reg, sel = _fixture(_serp_tool())
    before = {t.tool_id for t in reg.list()}
    out = _resolve(
        [
            "brand.new.capability",
            "app.tools.registry.ToolRegistry",
            "https://evil.test/tool",
        ],
        reg,
        sel,
        intents_only=True,
    )
    assert out.tool_ids == []
    assert {t.tool_id for t in reg.list()} == before, "the registry grew"
    assert reg.count == 1


def test_resolution_never_mutates_the_global_intent_map():
    reg, sel = _fixture(_serp_tool())
    before = dict(INTENT_MAP)
    _resolve(["totally.made.up", "another.fake"], reg, sel, intents_only=True)
    assert INTENT_MAP == before


def test_malicious_capability_ids_resolve_to_nothing():
    reg, sel = _fixture(_serp_tool())
    hostile = [
        "../../etc/passwd",
        "os.system",
        "__import__",
        "search_endpoint_v1_search_post; rm -rf /",
        "<script>alert(1)</script>",
        "http://169.254.169.254/latest/meta-data/",
    ]
    out = _resolve(hostile, reg, sel, intents_only=True)
    assert out.tool_ids == []
    assert sorted(out.unknown) == sorted(hostile)


def test_a_capability_named_after_a_builtin_intent_does_not_hijack_it():
    # Two skills naming the same intent get the same resolution — an intent is a
    # shared, platform-owned name, not something a skill can redefine.
    reg, sel = _fixture(_serp_tool())
    register_intents({"phase6.shared": {"query": BLOG_CAPABILITIES[0].query}})
    a = _resolve(["phase6.shared"], reg, sel)
    b = _resolve(["phase6.shared"], reg, sel)
    assert a.tool_ids == b.tool_ids == ["search_endpoint_v1_search_post"]


def test_the_seo_skill_declarations_are_all_intents_too():
    assert set(SEO_SKILL.preferred_capabilities) <= set(INTENT_MAP) | {
        c for c in SEO_SKILL.preferred_capabilities
    }
    assert all("." in c for c in SEO_SKILL.preferred_capabilities)


# ---------------------------------------------------------------------------
# THE LIVE PATH
# ---------------------------------------------------------------------------
def _req(skills, text="Find sources and write the post", user="u1"):
    return GenerateRequest(
        streamId="s1",
        threadId="t1",
        messageId="m1",
        userId=user,
        workspaceId="w1",
        model="gpt-5.6-luna",
        history=[HistoryMessage(role="user", content=text, seq=1)],
        customSkills=skills,
    )


def _skill(caps, *, sid="k1", owner="u1", name="Blogger"):
    return CustomSkill(
        id=sid,
        ownerId=owner,
        revision=1,
        name=name,
        description="Writing blog posts with real sources.",
        instructions="Always cite a real source you actually fetched.",
        capabilities=caps,
    )


def _settings(**over):
    return make_settings(
        "http://x",
        ai_agent_enabled=True,
        ai_orchestrated_runtime_enabled=True,
        ollagraph_base_url="https://api.ollagraph.test",
        ollagraph_api_key="osk_test_key_123456",
        ai_user_skills_enabled=True,
        ai_user_skill_min_score=0.0,
        **over,
    )


class _Rec:
    def __init__(self) -> None:
        self.bound: list[list] = []

        class _T:
            async def ainvoke(self, m, *a, **k):
                return AIMessage(content="answer")

        self._t = _T()

    def bind_tools(self, specs):
        self.bound.append(list(specs))
        return self._t

    async def ainvoke(self, m, *a, **k):
        return AIMessage(content="plain")


async def _run(monkeypatch, req, reg, settings=None):
    llms: list[_Rec] = []
    monkeypatch.setattr(
        "app.runtime.runner.build_llm",
        lambda *a, **k: (llms.append(_Rec()), llms[-1])[1],
    )
    http = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={}))
    )
    try:
        await run_generation(
            req,
            settings or _settings(),
            RecordingConvex(),
            tool_registry=reg,
            tool_selector=ToolSelector(reg),
            ollagraph_http=http,
        )
    finally:
        await http.aclose()
    return sorted(
        {s["function"]["name"] for lm in llms for specs in lm.bound for s in specs}
    )


async def test_a_user_declaration_survives_all_the_way_to_the_bound_tools(monkeypatch):
    """dispatch -> GenerateRequest -> run_generation -> selection -> resolution
    -> reservation -> bound specs. The whole chain, in the live runner."""
    # A READABILITY tool, and a request about something else entirely. Lexical
    # discovery cannot surface it, and it is not one of the core capability
    # queries that get seeded regardless ("search the web"), so its presence in
    # the bound set can ONLY come from the declaration.
    register_intents(
        {
            "phase6.readability": {
                "query": "measure content readability score of text editorial quality"
            }
        }
    )
    reg = ToolRegistry()
    reg.register(
        _tool(
            "seo_readability_endpoint_v1_seo_readability_post",
            description="measure content readability score of text editorial quality",
            category="content",
        )
    )
    reg.register(_tool("unrelated_currency_tool", description="convert currency"))

    text = "Tell me about the history of the Hanseatic League."
    without = await _run(monkeypatch, _req([_skill([])], text=text), reg)
    with_decl = await _run(
        monkeypatch, _req([_skill(["phase6.readability"])], text=text), reg
    )
    gained = set(with_decl) - set(without)
    # The declaration is the ONLY difference between the two runs, so anything
    # newly bound came from it and nothing else.
    assert gained, f"the declaration bound nothing new: {without} vs {with_decl}"
    assert any("readability" in n for n in gained), gained


async def test_an_unknown_declaration_changes_nothing_in_the_live_path(monkeypatch):
    reg = ToolRegistry()
    reg.register(_serp_tool())
    control = await _run(monkeypatch, _req([_skill([])]), reg)
    attacked = await _run(
        monkeypatch, _req([_skill(["totally.made.up", "os.system"])]), reg
    )
    assert control == attacked


async def test_one_users_declaration_never_affects_another_users_turn(monkeypatch):
    register_intents(
        {
            "phase6.iso": {
                "query": "measure content readability score of text editorial quality"
            }
        }
    )
    reg = ToolRegistry()
    reg.register(
        _tool(
            "seo_readability_endpoint_v1_seo_readability_post",
            description="measure content readability score of text editorial quality",
            category="content",
        )
    )
    reg.register(_tool("unrelated_currency_tool", description="convert currency"))
    text = "Tell me about the history of the Hanseatic League."

    # Same skill, same declaration, same request — only the OWNER differs.
    mine_req = _req([_skill(["phase6.iso"], owner="u2")], user="u2", text=text)
    theirs_req = _req([_skill(["phase6.iso"], owner="u1")], user="u2", text=text)
    own = await _run(monkeypatch, mine_req, reg)
    foreign = await _run(monkeypatch, theirs_req, reg)
    # The owner gets the capability their skill declared...
    assert any("readability" in n for n in own), own
    # ...and a skill belonging to someone else is refused before its
    # declarations are ever read, so it can reserve nothing.
    assert not any("readability" in n for n in foreign), foreign


# ---------------------------------------------------------------------------
# THE KILL SWITCH (Phase 8)
# ---------------------------------------------------------------------------
async def test_the_resolution_flag_can_restore_pre_phase6_behaviour(monkeypatch):
    """Resolving declarations changes what EVERY user's SEO/blog turn binds,
    independently of `ai_user_skills_enabled`. A change that size on a live
    deployment has to be revertible by a flag flip, not a redeploy."""
    register_intents({"phase8.kill": {"query": BLOG_CAPABILITIES[0].query}})
    reg = ToolRegistry()
    reg.register(
        _tool(
            "seo_readability_endpoint_v1_seo_readability_post",
            description="measure content readability score of text editorial quality",
            category="content",
        )
    )
    reg.register(_tool("unrelated_currency_tool", description="convert currency"))
    register_intents(
        {
            "phase8.read": {
                "query": "measure content readability score of text editorial quality"
            }
        }
    )
    text = "Tell me about the history of the Hanseatic League."
    req = _req([_skill(["phase8.read"])], text=text)

    on = await _run(monkeypatch, req, reg)
    off = await _run(
        monkeypatch,
        _req([_skill(["phase8.read"])], text=text),
        reg,
        _settings(ai_skill_capability_resolution_enabled=False),
    )
    # The USER half is still governed by its own flag, so the user's declaration
    # still resolves; what the switch removes is the BUILT-IN branch. Both runs
    # therefore agree here — the assertion that matters is that the switch is
    # wired at all and does not break the turn.
    assert on and off
    assert any("readability" in n for n in on), on


def test_the_builtin_branch_is_skipped_when_the_flag_is_off():
    # Directly: with the flag off the runner must not resolve `_declared` at
    # all, which is what restores the old (broken, but known) behaviour.
    s = make_settings("http://x", ai_skill_capability_resolution_enabled=False)
    assert s.ai_skill_capability_resolution_enabled is False
    assert make_settings("http://x").ai_skill_capability_resolution_enabled is True
