"""Teams API: live SSE stream + group-chat history for a team session.

- ``GET /teams/{id}/stream``  — drains the team's asyncio.Queue of AG-UI frames
  + group messages, as SSE. Keeps the connection open until the team finishes.
- ``GET /teams/{id}/messages`` — reconstructs the group chat from message_links
  (speaker + content + direction), for loading history when (re)opening a team.
- ``POST /teams/{id}/message`` — a user message into the team (routed to the
  teamleader, or a @-mentioned sub-agent in a later phase).
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..db import session_store
from ..team_runner import teams as team_registry

router = APIRouter(prefix="/teams", tags=["teams"])


async def _drain(queue: asyncio.Queue):
    """Yield SSE frames from the team's queue until the done sentinel."""
    while True:
        item = await queue.get()
        if isinstance(item, dict) and item.get("type") == "__team_done__":
            yield "data: [DONE]\n\n"
            return
        # items are already SSE-formatted strings ("data: {...}\n\n")
        yield item


@router.get("/{team_id}/stream")
async def stream_team(team_id: str) -> StreamingResponse:
    """SSE stream of a running team's group chat + agent events."""
    s = await session_store.get(team_id)
    if not s or s.get("kind") != "team":
        raise HTTPException(status_code=404, detail="team not found")

    queue = team_registry.get_queue(team_id)

    # If the team already finished, drain whatever is left then close.
    return StreamingResponse(
        _drain(queue),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/{team_id}/messages")
async def team_messages(team_id: str) -> dict:
    """Group-chat history for a team, reconstructed from message_links."""
    s = await session_store.get(team_id)
    if not s:
        raise HTTPException(status_code=404, detail="team not found")

    graph = await session_store.get_graph(team_id)
    # Flatten links into a chronological message list with speaker info.
    messages = []
    for link in graph.get("links", []):
        content = (link.get("data") or {}).get("content") or ""
        direction = (link.get("data") or {}).get("direction") or "chat"
        # speaker is parsed from the "[speaker] text" convention we store.
        speaker = "agent"
        text = content
        if content.startswith("[") and "]" in content:
            close = content.index("]")
            speaker = content[1:close]
            text = content[close + 1:].strip()
        messages.append(
            {
                "id": link.get("id"),
                "speaker": speaker,
                "text": text,
                "direction": direction,
                "source": link.get("source"),
                "target": link.get("target"),
            }
        )
    return {"team_id": team_id, "status": s.get("status"), "messages": messages}


class PostTeamMessage(BaseModel):
    content: str
    speaker: str = "user"
    target_agent: str | None = None  # @-mention target (later phase routing)


@router.post("/{team_id}/message")
async def post_team_message(team_id: str, body: PostTeamMessage) -> dict:
    """A user posts a message into the team chat.

    MVP: recorded as a group message_link. Routing the message to actually
    resume/affect a running agent is a later phase (needs the async mailbox).
    For now it's appended to the chat history.
    """
    s = await session_store.get(team_id)
    if not s:
        raise HTTPException(status_code=404, detail="team not found")

    await session_store.add_link(
        from_session_id=team_id,
        to_session_id=team_id,
        direction="chat",
        content=f"[{body.speaker}] {body.content}",
    )

    # If the team has a live queue, also push it so the open SSE view updates.
    if team_id in team_registry._queues:
        payload = {
            "type": "GROUP_MESSAGE",
            "messageId": f"u-{team_id}-{int(__import__('time').time())}",
            "speaker": body.speaker,
            "content": body.content,
            "direction": "mention" if body.target_agent else "chat",
        }
        await team_registry._queues[team_id].put(
            f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        )

    return {"ok": True, "team_id": team_id}
