"""Dynamic capability self-awareness.

`render_capability_overview` derives a compact, user-facing catalogue of what
OllaSuper can ACTUALLY do right now — from the enabled skills (`effective_skills`,
each `SkillManifest` declaring its own name/purpose/`metadata.category`) plus the
platform flags and the per-turn context. The runner injects it into the system prompt
every agentic turn, so "what can you do?" is answered from the live runtime state, not
a hand-maintained list. Adding a skill (registered in `effective_skills`) makes it
appear automatically; disabling a flag removes it, so the model can never claim it.

Pure + I/O-free (skills + context are passed in) so it is fully unit-testable, and it
emits ONLY user-facing text — no ids, flags, paths, or tool names.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.skills.manifest import SkillManifest

_DATA_SKILL_ID = "data-analysis"


def render_capability_overview(
    skills: list[SkillManifest],
    settings: object,
    *,
    has_datasets: bool = False,
    has_files: bool = False,
    memory_enabled: bool = False,
) -> str:
    """Build the `<your_capabilities>` block, grouped by category. Empty string when
    there is nothing to advertise (e.g. a bare non-agentic box)."""
    groups: OrderedDict[str, list[str]] = OrderedDict()

    def add(category: str, line: str) -> None:
        groups.setdefault(category, [])
        if line not in groups[category]:
            groups[category].append(line)

    # --- skills (the extensible part — self-declared name/purpose/category) ---
    for s in skills:
        category = (getattr(s, "metadata", None) or {}).get("category") or "General"
        purpose = (s.purpose or "").strip()
        line = f"{s.name}: {purpose}" if purpose else s.name
        # The contextual "upload a file to compute" note applies ONLY when the
        # compute capability is actually enabled — the generic base skill shares the
        # id "data-analysis" but has no compute tools, so it must not claim them.
        if s.skill_id == _DATA_SKILL_ID and getattr(
            settings, "ai_data_analysis_enabled", False
        ):
            note = (
                "a dataset is attached — I can analyze it now"
                if has_datasets
                else "attach a CSV/Excel file and I can analyze it"
            )
            line = f"{line} ({note})"
        add(category, line)

    # --- platform capabilities (flag-derived; the true runtime signal) --------
    if getattr(settings, "agent_enabled", False):
        add(
            "Web & Current Info",
            "Search the web for current, public, or fast-changing information "
            "(prices, news, availability, anything 'latest')",
        )
    add(
        "Files",
        "Analyze uploaded documents and images (PDF, Word, images, text, and more)",
    )
    if getattr(settings, "ai_agent_rag_tool_enabled", False) and has_files:
        add("Files", "Search across your uploaded documents / knowledge base")
    if getattr(settings, "ai_file_generation_enabled", False):
        add(
            "Files",
            "Generate downloadable files — PDF, Word, Excel, PowerPoint, and more",
        )
    if getattr(settings, "ai_agent_memory_tool_enabled", False) and memory_enabled:
        add(
            "Personalization",
            "Remember your preferences and stable facts across conversations",
        )
    add(
        "Visualization",
        "Create charts inline from data — bar, line, pie/doughnut, scatter, and more",
    )

    if not groups:
        return ""

    out = [
        "<your_capabilities>",
        "These are the capabilities actually available to you in this OllaSuper "
        "workspace right now. ONLY when the user asks what you can do, what your "
        "skills/tools are, or whether you can do a specific thing, answer from THIS "
        "list — accurately and in natural, friendly language (group related items, "
        "don't just dump the list). NEVER claim a capability that is not listed here, "
        "and note when something needs a file or dataset. Do not bring this up "
        "otherwise.",
    ]
    for category, items in groups.items():
        out.append(f"- {category}:")
        out.extend(f"  - {it}" for it in items)
    out.append("</your_capabilities>")
    return "\n".join(out)
