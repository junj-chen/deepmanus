"""AG-UI run endpoint.

``POST /`` accepts an AG-UI ``RunAgentInput`` and returns an
``text/event-stream`` of AG-UI events.

Memory fix: the thread_id used for the checkpointer is taken from the
session id (sent by the frontend), NOT the random UUID CopilotKit generates.
This keeps all messages of one conversation on the same checkpointer thread,
so the agent remembers across turns. If no session id is provided, a root
session is created on the first message.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Header, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..agui_bridge import AGUIBridge
from ..db import session_store

router = APIRouter()


def _extract_user_text(payload: dict[str, Any]) -> str:
    """Pull the latest user message text out of the AG-UI messages list."""
    messages = payload.get("messages") or []
    user_text = ""
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            user_text = content
        elif isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    parts.append(part.get("text", ""))
                elif isinstance(part, str):
                    parts.append(part)
            user_text = "".join(parts)
    return user_text or "Hello"


async def _ensure_session(payload: dict[str, Any], user_text: str) -> str:
    """Resolve the thread id (= session id) for this run.

    Priority: explicit sessionId in payload > existing session found by some
    id > create a new root session. The returned id is what the checkpointer
    keys on, so it must be stable across turns of the same conversation.
    """
    # The frontend sends the session id in a few possible fields.
    sid = (
        payload.get("sessionId")
        or payload.get("session_id")
        or payload.get("thread_id")
        or payload.get("threadId")
    )
    if sid:
        existing = await session_store.get(sid)
        if existing:
            return sid
        # id present but no session row yet -> create one with that id
        await session_store.create(session_id=sid, title=user_text[:50] or None)
        return sid

    # No id at all -> brand new root session.
    s = await session_store.create(title=user_text[:50] or None)
    return s["id"]


@router.post("/")
@router.post("")
async def run(
    payload: dict[str, Any],
    request: Request,
    x_session_id: str | None = Header(default=None, alias="x-session-id"),
) -> StreamingResponse:
    user_text = _extract_user_text(payload)
    # Session id can arrive in the body (sessionId/threadId) or via the
    # x-session-id header (set by the frontend's dynamic headers prop).
    if x_session_id:
        payload.setdefault("sessionId", x_session_id)
    thread_id = await _ensure_session(payload, user_text)
    run_id = payload.get("run_id") or payload.get("runId") or f"run-{uuid.uuid4().hex}"

    # Resolve which agent to use: per-session workdir (each workdir has its own
    # cached agent instance). Fall back to the default agent.
    from ..agent_factory import get_agent_for_workdir

    session = await session_store.get(thread_id)
    workdir = (session or {}).get("workdir") if session else None
    if workdir:
        agent = await get_agent_for_workdir(workdir)
    else:
        agent = request.app.state.agent
    bridge = AGUIBridge(agent)

    async def stream():
        try:
            # "running" so the session list shows a spinner while the agent works;
            # reset to "active" on completion so it stops spinning.
            await session_store.update(thread_id, status="running")
            async for frame in bridge.run(
                thread_id=thread_id, run_id=run_id, user_text=user_text
            ):
                yield frame
        finally:
            # mark done + touched so it sorts to the top of the list
            await session_store.update(thread_id, status="active", touch=True)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            # tell the client which session/thread this run belonged to
            "X-Session-Id": thread_id,
        },
    )


class HealthResponse(BaseModel):
    status: str
    model: str
    workdir: str


@router.get("/health")
async def health() -> HealthResponse:
    from ..config import settings

    return HealthResponse(status="ok", model=settings.model, workdir=settings.workdir)
