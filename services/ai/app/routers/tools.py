"""Read-only Tool Registry introspection.

Metadata only — this NEVER executes a tool and is NOT wired to the model
(analogous to a `GET /v1/models`). Service-key gated like the rest of `/v1`.
It exists so operators can see the discovered/registered count (Phase-1
acceptance) and so Phase 2 has a concrete interface to read the catalogue.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from app.security import require_service_key
from app.tools.registry import ToolRegistry

router = APIRouter(prefix="/v1", dependencies=[Depends(require_service_key)])


def _registry(request: Request) -> ToolRegistry:
    reg = getattr(request.app.state, "tool_registry", None)
    if reg is None:
        raise HTTPException(status_code=503, detail="tool registry not enabled")
    return reg


@router.get("/tools")
async def list_tools(
    request: Request,
    category: str | None = None,
    enabled: bool | None = None,
) -> dict:
    reg = _registry(request)
    tools = reg.by_category(category) if category else reg.list()
    if enabled is not None:
        tools = [t for t in tools if t.enabled is enabled]
    return {
        **reg.snapshot(),
        "returned": len(tools),
        # Compact rows — full input/output schemas via /v1/tools/{tool_id}.
        "tools": [
            {
                "tool_id": t.tool_id,
                "name": t.name,
                "category": t.category,
                "provider": t.provider,
                "side_effect": str(t.side_effect),
                "enabled": t.enabled,
                "availability": str(t.availability),
                "required_auth": t.required_auth,
                "method": t.method,
                "path": t.path,
            }
            for t in tools
        ],
    }


@router.get("/tools/{tool_id}")
async def get_tool(request: Request, tool_id: str) -> dict:
    reg = _registry(request)
    tool = reg.get(tool_id)
    if tool is None:
        raise HTTPException(status_code=404, detail="tool not found")
    return tool.model_dump()
