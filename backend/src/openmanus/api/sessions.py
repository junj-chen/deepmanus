"""Sessions REST API.

CRUD for sessions (the agent-conversation nodes) plus a graph endpoint that
returns the {nodes, links} collaboration view for reactflow. The frontend
SessionStore (mobx) calls these — views never hit this directly.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..db import session_store
from ..single_runner import singles as single_registry

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
    """Session metadata + message history as a flat timeline.

    The history is read from the deepagents checkpointer for this thread and
    flattened into the SAME segment shape the live stream produces, so the
    frontend can drop it straight into ChatStore.items:

      { kind:'user',          id, text }
      { kind:'assistant-text', id, text }
      { kind:'tool',          id, name, args, result }
      { kind:'assistant-text', id, text }   # post-tool text

    An AIMessage may carry text AND one or more tool_calls; each tool_call
    becomes its own 'tool' segment (its result comes from the later
    ToolMessage, matched by tool_call_id). This preserves the real
    text→tool→text ordering.
    """
    s = await session_store.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="session not found")

    history: list[dict] = []
    try:
        agent = request.app.state.agent
        snapshot = await agent.aget_state(
            {"configurable": {"thread_id": session_id}}
        )
        messages = (getattr(snapshot, "values", {}) or {}).get("messages", [])

        # tool_call_id -> segment index, so a later ToolMessage can fill result
        tool_seg_index: dict[str, int] = {}

        for msg in messages:
            mtype = getattr(msg, "type", "")
            mid = getattr(msg, "id", None) or ""
            content = getattr(msg, "content", "")

            if mtype == "human":
                text = _content_to_text(content)
                if text.strip():
                    history.append({"kind": "user", "id": mid, "text": text})

            elif mtype == "ai":
                text = _content_to_text(content)
                if text.strip():
                    history.append(
                        {"kind": "assistant-text", "id": mid, "text": text}
                    )
                # each tool call the model issued -> a 'tool' segment
                for tc in getattr(msg, "tool_calls", None) or []:
                    tcid = tc.get("id") or ""
                    seg = {
                        "kind": "tool",
                        "id": tcid,
                        "name": tc.get("name", "tool"),
                        "args": _stringify_args(tc.get("args")),
                        "result": None,
                    }
                    tool_seg_index[tcid] = len(history)
                    history.append(seg)

            elif mtype == "tool":
                # back-fill the matching tool segment's result
                tcid = getattr(msg, "tool_call_id", "") or ""
                idx = tool_seg_index.get(tcid)
                if idx is not None:
                    history[idx]["result"] = _content_to_text(content)
    except Exception:
        # history is best-effort; never fail the whole response
        pass

    s["messages"] = history
    return s


def _content_to_text(content: Any) -> str:
    """Normalize a message's content (str or content-block list) to text."""
    if isinstance(content, list):
        return " ".join(
            p.get("text", "") if isinstance(p, dict) else str(p) for p in content
        ).strip()
    return str(content) if content else ""


def _stringify_args(args: Any) -> str:
    """Render a tool_call's args dict as a compact JSON string (for display)."""
    if not args:
        return ""
    try:
        import json

        return json.dumps(args, ensure_ascii=False)
    except Exception:
        return str(args)


class UpdatePreview(BaseModel):
    preview: str
    speaker: str | None = None


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


@router.post("/{session_id}/preview")
async def set_preview(session_id: str, body: UpdatePreview) -> dict:
    """Set the session's last-message preview (and optionally speaker).

    The preview is merged into the session's metadata (NOT a full overwrite),
    so existing metadata like parent/role/members is preserved. This is what
    the session list shows as the second line (WeChat-style preview).
    """
    existing = await session_store.get(session_id)
    if not existing:
        raise HTTPException(status_code=404, detail="session not found")
    md = dict(existing.get("metadata") or {})
    md["preview"] = (body.preview or "")[:120]
    if body.speaker:
        md["preview_speaker"] = body.speaker
    s = await session_store.update(session_id, metadata=md)
    return s or existing


@router.delete("/{session_id}")
async def delete_session(session_id: str) -> dict:
    ok = await session_store.delete(session_id)
    if not ok:
        raise HTTPException(status_code=404, detail="session not found")
    return {"deleted": session_id}


@router.post("/{session_id}/reset")
async def reset_session(session_id: str, request: Request) -> dict:
    """Reset a session's conversation history (clear the checkpointer thread).

    Used by the default entry's "new chat": the default item is permanent and
    can't be deleted, so starting fresh means wiping its message history. The
    session row itself is untouched (only its checkpointer thread is cleared).
    """
    if not await session_store.get(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    try:
        agent = request.app.state.agent
        checkpointer = getattr(agent, "checkpointer", None)
        if checkpointer is not None and hasattr(checkpointer, "adelete_thread"):
            await checkpointer.adelete_thread(session_id)
    except Exception:
        # best-effort; don't fail the request if the thread can't be cleared
        pass
    return {"reset": session_id}


@router.get("/{session_id}/graph")
async def get_session_graph(session_id: str) -> dict:
    """Return the collaboration graph {nodes, links} for reactflow."""
    if not await session_store.get(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    return await session_store.get_graph(session_id)


async def _drain_single(queue: asyncio.Queue):
    """Yield SSE frames from a single-agent's queue until the done sentinel."""
    while True:
        item = await queue.get()
        if isinstance(item, dict) and item.get("type") == "__single_done__":
            yield "data: [DONE]\n\n"
            return
        # items are already SSE-formatted strings ("data: {...}\n\n")
        yield item


@router.get("/{session_id}/stream")
async def stream_session(session_id: str) -> StreamingResponse:
    """Live SSE stream of a running single-agent (subagent) session.

    Mirrors the team stream: drains the agent's asyncio.Queue of AG-UI frames
    (produced by single_runner via AGUIBridge). The frames are standard AG-UI,
    so the frontend's existing ChatStore._handleEvent reducer renders them
    unchanged. Closes with ``[DONE]`` when the agent finishes.
    """
    s = await session_store.get(session_id)
    if not s:
        raise HTTPException(status_code=404, detail="session not found")
    if s.get("kind") != "subagent":
        raise HTTPException(status_code=400, detail="stream is for subagent sessions only")

    queue = single_registry.get_queue(session_id)
    return StreamingResponse(
        _drain_single(queue),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


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
