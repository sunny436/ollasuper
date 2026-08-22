"""In-process Tool Registry.

Analogous to runtime/registry.py (an in-process holder attached to app.state).
Holds normalized `ToolDefinition`s + the provider's `components.schemas` for
lazy `$ref` resolution. It is a passive catalogue: it exposes lookups but is
NOT connected to the LLM/graph and executes nothing.
"""

from __future__ import annotations

from app.models.tools import ToolDefinition


class ToolRegistry:
    def __init__(self) -> None:
        self._by_id: dict[str, ToolDefinition] = {}
        self._by_name: dict[str, str] = {}  # name -> tool_id (first wins)
        self._by_category: dict[str, list[str]] = {}
        self._components: dict = {}
        self._report: dict = {}

    # --- population -------------------------------------------------------
    def register(self, tool: ToolDefinition) -> None:
        """Add/replace one tool. Idempotent by `tool_id`."""
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

    def replace_all(
        self,
        tools: list[ToolDefinition],
        components: dict | None = None,
        report: dict | None = None,
    ) -> None:
        """Atomically swap the whole catalogue (used by refresh)."""
        by_id: dict[str, ToolDefinition] = {}
        by_name: dict[str, str] = {}
        by_category: dict[str, list[str]] = {}
        for t in tools:
            by_id[t.tool_id] = t
            by_name.setdefault(t.name, t.tool_id)
            by_category.setdefault(t.category, []).append(t.tool_id)
        self._by_id = by_id
        self._by_name = by_name
        self._by_category = by_category
        if components is not None:
            self._components = components
        if report is not None:
            self._report = report

    # --- lookups ----------------------------------------------------------
    def get(self, tool_id: str) -> ToolDefinition | None:
        return self._by_id.get(tool_id)

    def get_by_name(self, name: str) -> ToolDefinition | None:
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
        return dict(self._report)

    @property
    def components(self) -> dict:
        return self._components

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
        Nested `$ref`s inside properties are intentionally left as-is."""
        if not isinstance(schema, dict):
            return schema
        ref = schema.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
            name = ref.rsplit("/", 1)[-1]
            seen = _seen or set()
            if name in seen:
                return {"$ref": ref}  # cycle — stop here
            target = self._components.get(name, {})
            return self.resolve_schema(target, seen | {name})
        return schema
