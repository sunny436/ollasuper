"""In-process Tool Registry.

Analogous to runtime/registry.py (an in-process holder attached to app.state).
Holds normalized `ToolDefinition`s + each provider's `components.schemas` for
lazy `$ref` resolution. It is a passive catalogue: it exposes lookups but is
NOT connected to the LLM/graph and executes nothing.

Provider-partitioned: tools carry `provider`, and components/report are stored
PER PROVIDER so one provider's refresh (`replace_provider`) can never erase
another's tools, and two providers can define same-named schemas without
colliding (`components_for(provider)`). The global `components`/`report`/
`snapshot` views are merged over the per-provider maps — for the single-provider
config in use today they are byte-identical to the previous flat behavior.
"""

from __future__ import annotations

from app.models.tools import ToolDefinition


class ToolRegistry:
    def __init__(self) -> None:
        self._by_id: dict[str, ToolDefinition] = {}
        self._by_name: dict[str, str] = {}  # name -> tool_id (first wins)
        self._by_category: dict[str, list[str]] = {}
        # Per-provider so replace_provider() is surgical and schema names never
        # collide across providers.
        self._components_by_provider: dict[str, dict] = {}
        self._report_by_provider: dict[str, dict] = {}
        # Bumped on any mutation so consumers (e.g. the discovery search index)
        # can cache derived state and rebuild only when the catalogue changes.
        self._version = 0

    @property
    def version(self) -> int:
        return self._version

    # --- population -------------------------------------------------------
    def _add(self, tool: ToolDefinition) -> None:
        """Insert/replace one tool WITHOUT bumping the version (internal)."""
        existing = self._by_id.get(tool.tool_id)
        if existing is not None and existing.category != tool.category:
            ids = self._by_category.get(existing.category)
            if ids and tool.tool_id in ids:
                ids.remove(tool.tool_id)
        self._by_id[tool.tool_id] = tool
        self._by_name.setdefault(tool.name, tool.tool_id)
        bucket = self._by_category.setdefault(tool.category, [])
        if tool.tool_id not in bucket:
            bucket.append(tool.tool_id)

    def register(self, tool: ToolDefinition) -> None:
        """Add/replace one tool. Idempotent by `tool_id`."""
        self._add(tool)
        self._version += 1

    def _drop_provider(self, provider_id: str) -> None:
        """Remove all tools whose `provider == provider_id` (no version bump)."""
        to_remove = [
            tid for tid, t in self._by_id.items() if t.provider == provider_id
        ]
        for tid in to_remove:
            t = self._by_id.pop(tid)
            ids = self._by_category.get(t.category)
            if ids and tid in ids:
                ids.remove(tid)
                if not ids:
                    self._by_category.pop(t.category, None)
            # Only drop the name mapping if it still points at this tool.
            if self._by_name.get(t.name) == tid:
                self._by_name.pop(t.name, None)

    def replace_provider(
        self,
        provider_id: str,
        defs: list[ToolDefinition],
        components: dict | None = None,
        report: dict | None = None,
    ) -> None:
        """Swap ONE provider's slice: drop its existing tools/components/report,
        insert the new ones, leave every other provider untouched."""
        self._drop_provider(provider_id)
        for t in defs:
            self._add(t)
        if components is not None:
            self._components_by_provider[provider_id] = components
        if report is not None:
            self._report_by_provider[provider_id] = report
        self._version += 1

    def replace_all(
        self,
        tools: list[ToolDefinition],
        components: dict | None = None,
        report: dict | None = None,
    ) -> None:
        """Atomically swap the whole catalogue (used by single-provider refresh).

        Preserves the "clear everything then add" semantic. The flat
        `components`/`report` belong to the provider(s) present in `tools` (one,
        in the current config), so they are stored under each such provider —
        keeping `components`/`report`/`snapshot` byte-identical to the old flat
        behavior for a single provider.
        """
        self._by_id = {}
        self._by_name = {}
        self._by_category = {}
        self._components_by_provider = {}
        self._report_by_provider = {}
        providers: set[str] = set()
        for t in tools:
            self._add(t)
            providers.add(t.provider)
        for p in providers:
            if components is not None:
                self._components_by_provider[p] = components
            if report is not None:
                self._report_by_provider[p] = report
        self._version += 1

    # --- lookups ----------------------------------------------------------
    def get(self, tool_id: str) -> ToolDefinition | None:
        return self._by_id.get(tool_id)

    def get_by_name(self, name: str) -> ToolDefinition | None:
        """Deprecated once multiple providers coexist (names are unique only
        within a provider). Retained for internal single-provider callers."""
        tool_id = self._by_name.get(name)
        return self._by_id.get(tool_id) if tool_id else None

    def by_category(self, category: str) -> list[ToolDefinition]:
        return [self._by_id[i] for i in self._by_category.get(category, [])]

    def list(self) -> list[ToolDefinition]:
        return list(self._by_id.values())

    def categories(self) -> dict[str, int]:
        return {c: len(ids) for c, ids in self._by_category.items()}

    @property
    def count(self) -> int:
        return len(self._by_id)

    @property
    def report(self) -> dict:
        """Merged global report. One provider => that provider's report verbatim
        (byte-identical to the old flat `report`)."""
        reports = self._report_by_provider
        if len(reports) == 1:
            return dict(next(iter(reports.values())))
        merged: dict = {"providers": {}}
        for p, r in reports.items():
            merged["providers"][p] = r
        return merged

    @property
    def components(self) -> dict:
        """Merged global components. One provider => that provider's map (the
        same object), so single-provider `$ref` resolution is byte-identical."""
        comps = self._components_by_provider
        if len(comps) == 1:
            return next(iter(comps.values()))
        merged: dict = {}
        for c in comps.values():
            merged.update(c)
        return merged

    def components_for(self, provider: str) -> dict:
        """The schema components scoped to one provider (collision-proof)."""
        return self._components_by_provider.get(provider, {})

    def snapshot(self) -> dict:
        """Compact, credential-free summary for the introspection route/logs."""
        enabled = sum(1 for t in self._by_id.values() if t.enabled)
        return {
            "count": self.count,
            "enabled": enabled,
            "categories": dict(
                sorted(self.categories().items(), key=lambda kv: -kv[1])
            ),
            "report": self.report,
        }

    # --- lazy schema resolution ------------------------------------------
    def resolve_schema(self, schema: dict, _seen: set[str] | None = None) -> dict:
        """Resolve a top-level `#/components/schemas/X` chain, guarding cycles.
        Nested `$ref`s inside properties are intentionally left as-is. Resolves
        against the merged component view (single-provider: byte-identical)."""
        if not isinstance(schema, dict):
            return schema
        ref = schema.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            name = ref.rsplit("/", 1)[-1]
            seen = _seen or set()
            if name in seen:
                return {"$ref": ref}  # cycle — stop here
            target = self.components.get(name, {})
            return self.resolve_schema(target, seen | {name})
        return schema
