"""dispatch_to_team tool: the default agent delegates to a background team.

When the default (entry) agent decides a task needs a team, it calls
``dispatch_to_team``. This tool:
  1. Creates a team session (kind=team).
  2. Launches the teamleader as a BACKGROUND asyncio task (team_runner) —
     non-blocking, so the default session can finish immediately.
  3. Records a message_link (default -> team).
  4. Returns a short "delegated to team <id>" message to the default agent,
     which then summarises for the user.

The user can then open the team in the UI to watch the group chat unfold live.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool, tool
from langchain_core.tools.base import InjectedToolArg
from pydantic import BaseModel, Field

from ..db import session_store
from ..team_runner import launch_team

logger = logging.getLogger(__name__)


class DispatchToTeamInput(BaseModel):
    task_description: str = Field(
        description=(
            "The full task to hand off to the team. Be detailed: this is the "
            "only context the team leader receives. Include goals, constraints, "
            "relevant file paths."
        )
    )


def make_dispatch_to_team_tool(*, team_agent_ref: Any) -> BaseTool:
    """Build the dispatch_to_team tool.

    ``team_agent_ref`` is a dict that will later hold the compiled teamleader
    agent (built separately from the default agent).
    """

    @tool("dispatch_to_team", args_schema=DispatchToTeamInput)
    async def dispatch_to_team(
        task_description: str,
        config: Annotated[RunnableConfig, InjectedToolArg],
    ) -> str:
        """Delegate a large/multi-step task to a background team.

        Use this when a task benefits from multiple specialised agents working
        together. The task runs asynchronously in the background — this returns
        immediately with a team id. The user can open the team chat to watch
        progress. Do NOT call this for simple tasks you can do yourself.
        """
        default_session_id = (
            (config or {}).get("configurable", {}).get("thread_id") or "unknown"
        )

        # Create the team session.
        team = await session_store.create(
            kind="team",
            name="teamleader",
            title=task_description[:60] or "team task",
            metadata={"parent": default_session_id},
        )
        team_id = team["id"]
        await session_store.update(team_id, status="running")

        # Launch the teamleader in the background (non-blocking).
        team_agent = (
            team_agent_ref["agent"] if isinstance(team_agent_ref, dict) else team_agent_ref
        )
        launch_team(
            team_agent=team_agent,
            team_id=team_id,
            task_description=task_description,
            default_session_id=default_session_id,
        )

        # Record the delegation edge.
        await session_store.add_link(
            from_session_id=default_session_id,
            to_session_id=team_id,
            direction="dispatch",
            content=task_description,
        )

        return (
            f"Delegated to team {team_id}. The team is now working on it in the "
            f"background. Tell the user they can open team {team_id[:12]} in the "
            f"sidebar to watch the group chat."
        )

    return dispatch_to_team
