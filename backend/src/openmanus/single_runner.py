"""Single-agent background runner with live SSE streaming.

When the default (entry) agent decides a task is a clear single-specialist job,
it calls ``dispatch_single`` (tools/dispatch_single.py), which creates a
subagent session and launches it HERE as a background ``asyncio.Task``.

The sub-agent runs on its own checkpointer thread (session id). As it works,
its events are streamed (astream → AGUIBridge → queue) exactly like a normal
agent chat, so the frontend can open a live SSE connection (GET
/sessions/:id/stream) and watch it token-by-token using the SAME ChatStore
reducer it already uses for the default agent.

Mirrors the team_runner pattern (registry + queue + drain), minus the
group-message concept — a single agent emits pure AG-UI frames.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from langchain_core.messages import HumanMessage

from .agui_bridge import AGUIBridge, _StreamState
from .db import session_store

logger = logging.getLogger(__name__)


class SingleRegistry:
    """In-process registry of live single-agent queues (mirror of TeamRegistry)."""

    def __init__(self) -> None:
        self._queues: dict[str, asyncio.Queue[str]] = {}

    def get_queue(self, session_id: str) -> asyncio.Queue:
        q = self._queues.get(session_id)
        if q is None:
            q = asyncio.Queue()
            self._queues[session_id] = q
        return q

    def has(self, session_id: str) -> bool:
        return session_id in self._queues

    def discard(self, session_id: str) -> None:
        self._queues.pop(session_id, None)


# module-level singleton
singles = SingleRegistry()


def _DONE_SENTINEL() -> dict:
    return {"type": "__single_done__"}


def launch_single(
    *,
    agent: Any,
    session_id: str,
    role: str,
    task_description: str,
    parent_session_id: str,
) -> None:
    """Launch a single sub-agent in the background (non-blocking)."""
    task = asyncio.create_task(
        _run_single_agent(
            agent=agent,
            session_id=session_id,
            role=role,
            task_description=task_description,
            parent_session_id=parent_session_id,
        )
    )
    logger.info("launched single agent %s (role=%s)", session_id, role)


async def _run_single_agent(
    *,
    agent: Any,
    session_id: str,
    role: str,
    task_description: str,
    parent_session_id: str,
) -> None:
    """Run the sub-agent on its own thread, streaming AG-UI frames to a queue.

    The role prompt is prepended to the task so the (shared) graph behaves as
    that specialist. Output lands in the checkpointer under session_id AND is
    streamed live to the session's SSE queue.
    """
    queue = singles.get_queue(session_id)
    bridge = AGUIBridge(agent)
    st = _StreamState()
    config = {"configurable": {"thread_id": session_id}}
    # lazy import to avoid a circular import at module load time
    # (tools.roles → tools/__init__ → dispatch_single → single_runner)
    from .tools.roles import role_prompt

    prompt = f"{role_prompt(role)}\n\nTask:\n{task_description}"

    try:
        async for chunk in agent.astream(
            {"messages": [HumanMessage(content=prompt)]},
            config=config,
            stream_mode=["messages", "updates"],
            subgraphs=True,
            version="v2",
        ):
            for frame in bridge._handle_chunk(chunk, st):
                await queue.put(frame)
        await session_store.update(session_id, status="done", touch=True)
    except Exception as exc:  # noqa: BLE001
        logger.exception("single agent %s failed", session_id)
        await session_store.update(session_id, status="error", touch=True)
        await session_store.add_link(
            from_session_id=session_id,
            to_session_id=parent_session_id,
            direction="result",
            content=f"(sub-agent '{role}' failed: {exc})"[:500],
        )
    finally:
        # signal the SSE drainer that the stream is over
        await queue.put(_DONE_SENTINEL())
        # keep the queue around briefly so a late SSE connection can still drain;
        # it's discarded once the agent is done. We discard on next launch cycle
        # to avoid a race with a client still connecting.
