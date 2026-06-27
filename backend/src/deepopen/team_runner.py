"""Team runner: orchestrates a background teamleader agent.

When the default agent delegates a task to a team, we launch the teamleader as
a BACKGROUND asyncio task (so the default session returns immediately), feed
its streaming events into an asyncio.Queue (drained by the SSE endpoint), and
record its messages as group-chat message_links.

The teamleader coordinates sub-agents via the existing synchronous
``dispatch_task`` tool (each delegation still creates a child session +
message_links). Later phases can upgrade to inter-agent async mailbox.

Key invariants:
- Each team has ONE queue (consumed by GET /teams/{id}/stream).
- The teamleader runs on its OWN thread_id (= team session id) so its history
  is isolated.
- Team lifecycle: created(running) -> done/error. Persisted via session_store.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from langchain_core.messages import HumanMessage

from .agui_bridge import AGUIBridge, _StreamState
from .db import session_store

logger = logging.getLogger(__name__)

# A sentinel pushed onto the queue to signal "team finished" to the SSE drain.
_DONE = {"type": "__team_done__"}


class TeamRegistry:
    """In-process registry of running teams and their event queues.

    MVP: in-memory only (a process restart loses running teams). Persisting
    active-team state is a later phase.
    """

    def __init__(self) -> None:
        # team_id -> asyncio.Queue of AG-UI frame strings
        self._queues: dict[str, asyncio.Queue[str]] = {}
        # team_id -> asyncio.Task
        self._tasks: dict[str, asyncio.Task] = {}

    def get_queue(self, team_id: str) -> asyncio.Queue[str]:
        if team_id not in self._queues:
            self._queues[team_id] = asyncio.Queue()
        return self._queues[team_id]

    def is_running(self, team_id: str) -> bool:
        t = self._tasks.get(team_id)
        return t is not None and not t.done()

    def register_task(self, team_id: str, task: asyncio.Task) -> None:
        self._tasks[team_id] = task

    def team_ids(self) -> list[str]:
        return list(self._queues.keys())


# Module-level singleton
teams = TeamRegistry()


async def _run_teamleader(
    *,
    team_agent: Any,
    team_id: str,
    task_description: str,
    default_session_id: str,
) -> None:
    """Run the teamleader on its own thread, streaming events into the queue.

    Reuses AGUIBridge's pure ``_handle_chunk`` to map langgraph stream chunks
    to AG-UI frames, so the team SSE looks the same as a normal agent SSE.
    Also records the teamleader's final text answer as a group-chat message.
    """
    queue = teams.get_queue(team_id)
    bridge = AGUIBridge(team_agent)
    st = _StreamState()

    # Record the user's original task as a group message into the team.
    await session_store.add_link(
        from_session_id=default_session_id,
        to_session_id=team_id,
        direction="dispatch",
        content=task_description,
    )

    config = {"configurable": {"thread_id": team_id}}
    final_text = ""

    try:
        # Emit a synthetic "team started" group message.
        await _push_group_message(
            queue, team_id, speaker="teamleader",
            text=f"📝 Team started. Task: {task_description[:120]}",
        )

        async for chunk in team_agent.astream(
            {"messages": [HumanMessage(content=task_description)]},
            config=config,
            stream_mode=["messages", "updates"],
            subgraphs=True,
            version="v2",
        ):
            for frame in bridge._handle_chunk(chunk, st):
                await queue.put(frame)
                # capture teamleader text for the final group message
        # pull final assistant text from state
        snapshot = await team_agent.aget_state(config)
        for msg in reversed(getattr(snapshot, "values", {}).get("messages", [])):
            if getattr(msg, "type", "") == "ai":
                content = getattr(msg, "content", "")
                if isinstance(content, list):
                    content = " ".join(
                        p.get("text", "") if isinstance(p, dict) else str(p)
                        for p in content
                    )
                final_text = str(content)
                break

        await _push_group_message(
            queue, team_id, speaker="teamleader",
            text=final_text or "(team finished)",
        )
        await session_store.update(team_id, status="done")
    except Exception as exc:  # noqa: BLE001
        logger.exception("team %s failed", team_id)
        await _push_group_message(
            queue, team_id, speaker="system",
            text=f"❌ Team failed: {exc}",
        )
        await session_store.update(team_id, status="error")
    finally:
        await queue.put(_DONE_SENTINEL())


async def _push_group_message(
    queue: asyncio.Queue, team_id: str, *, speaker: str, text: str
) -> None:
    """Push a group-chat message both to the SSE queue and to message_links.

    The SSE frame uses a CUSTOM event type so the frontend can render it as a
    distinct group message (with speaker). message_links persists it.
    """
    msg_id = uuid.uuid4().hex
    # Record in the collaboration graph: speaker -> team.
    await session_store.add_link(
        from_session_id=team_id,  # simplified: attribute to team for now
        to_session_id=team_id,
        direction="chat",
        content=f"[{speaker}] {text}",
    )
    # SSE frame: a CUSTOM group-message event (speaker + content) the frontend
    # renders as a distinct chat bubble. (Not standard AG-UI, but our own.)
    import json

    payload = {
        "type": "GROUP_MESSAGE",
        "messageId": msg_id,
        "speaker": speaker,
        "content": text,
    }
    frame = f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
    await queue.put(frame)


def _DONE_SENTINEL() -> dict:
    return _DONE


def launch_team(
    *,
    team_agent: Any,
    team_id: str,
    task_description: str,
    default_session_id: str,
) -> None:
    """Launch the teamleader as a background task (non-blocking)."""
    task = asyncio.create_task(
        _run_teamleader(
            team_agent=team_agent,
            team_id=team_id,
            task_description=task_description,
            default_session_id=default_session_id,
        )
    )
    teams.register_task(team_id, task)
    logger.info("launched team %s (leader on thread %s)", team_id, team_id)
