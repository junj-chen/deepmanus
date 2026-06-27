"""Sessions REST API.

CRUD for sessions (the agent-conversation nodes) plus a graph endpoint that
returns the {nodes, links} collaboration view for reactflow. The frontend
SessionStore (mobx) calls these — views never hit this directly.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..db import session_store

router = APIRouter(prefix="/sessions", tags=["sessions"])


class CreateSession(BaseModel):
    kind: str = "root"
    name: str | None = None
    title: str | None = None
    workdir: str | None = None
    metadata: dict[str, Any] = {}


class UpdateSession(BaseModel):
    title: str | None = None
    status: str | None = None
    workdir: str | None = None
    metadata: dict[str, Any] | None = None


class SessionSummary(BaseModel):
    id: str
    kind: str
    name: str | None = None
    status: str
    title: str | None = None
    model: str | None = None
    workdir: str | None = None
    created_at: str | None = None
    updated_at: str | None = None


@router.post("", response_model=dict, status_code=201)
@router.post("/", response_model=dict, status_code=201, include_in_schema=False)
async def create_session(body: CreateSession) -> dict:
    return await session_store.create(
        kind=body.kind,
        name=body.name,
        title=body.title,
        workdir=body.workdir,
        metadata=body.metadata,
    )


@router.get("", response_model=list[SessionSummary])
@router.get("/", response_model=list[SessionSummary], include_in_schema=False)
async def list_sessions(kind: str | None = None) -> list[dict]:
    return await session_store.list(kind=kind)


@router.get("/{session_id}")
async def get_session(session_id: str, request: Request) -> dict:
    """Session metadata + message history (read from the checkpointer)."""
    s = await session_store.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="session not found")

    # Pull conversation history from the deepagents checkpointer for this thread.
    history: list[dict] = []
    try:
        agent = request.app.state.agent
        snapshot = await agent.aget_state(
            {"configurable": {"thread_id": session_id}}
        )
        for msg in (getattr(snapshot, "values", {}) or {}).get("messages", []):
            role = getattr(msg, "type", "user")
            content = getattr(msg, "content", "")
            if isinstance(content, list):
                # content blocks -> join text parts
                content = " ".join(
                    p.get("text", "") if isinstance(p, dict) else str(p)
                    for p in content
                )
            text = str(content) if content else ""
            if not text.strip():
                continue
            history.append(
                {
                    "id": getattr(msg, "id", None) or "",
                    "role": "assistant" if role == "ai" else role,
                    "content": text,
                }
            )
    except Exception:
        # history is best-effort; never fail the whole response
        pass

    s["messages"] = history
    return s


@router.patch("/{session_id}")
async def update_session(session_id: str, body: UpdateSession) -> dict:
    s = await session_store.update(
        session_id,
        title=body.title,
        status=body.status,
        workdir=body.workdir,
        metadata=body.metadata,
    )
    if not s:
        raise HTTPException(status_code=404, detail="session not found")
    return s


@router.delete("/{session_id}")
async def delete_session(session_id: str) -> dict:
    ok = await session_store.delete(session_id)
    if not ok:
        raise HTTPException(status_code=404, detail="session not found")
    return {"deleted": session_id}


@router.get("/{session_id}/graph")
async def get_session_graph(session_id: str) -> dict:
    """Return the collaboration graph {nodes, links} for reactflow."""
    if not await session_store.get(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    return await session_store.get_graph(session_id)


# --- Workdir validation (top-level, not under /sessions) -------------------
workdir_router = APIRouter(tags=["workdir"])


class ValidateWorkdir(BaseModel):
    path: str


@workdir_router.post("/workdir/validate")
async def validate_workdir(body: ValidateWorkdir) -> dict:
    """Check that a workdir path exists and is a directory."""
    import os

    from pathlib import Path

    p = Path(body.path).expanduser()
    exists = p.exists()
    is_dir = p.is_dir()
    # list a few entries to confirm readability + give the UI something to show
    entries: list[str] = []
    if is_dir:
        try:
            entries = sorted([e.name for e in p.iterdir()])[:12]
        except (PermissionError, OSError):
            entries = []
    return {
        "path": str(p),
        "exists": exists,
        "is_dir": is_dir,
        "valid": exists and is_dir,
        "entries": entries,
    }
