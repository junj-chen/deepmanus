"""dispatch_single tool: the default agent delegates ONE task to a single
specialist sub-agent (coder/researcher), asynchronously.

When the default (entry) agent decides a task is a clear single-specialist job
(e.g. "implement BFS" → coder), it calls ``dispatch_single``. This tool:
  1. Creates a subagent session (kind=subagent, name=<role>).
  2. Launches the sub-agent in the BACKGROUND (single_runner) — non-blocking,
     so the default session finishes immediately with a short "delegated"
     message. The sub-agent's work happens on its own checkpointer thread.
  3. Records a message_link (default -> subagent).
  4. Returns a short "delegated to <role>, watch it in Tasks" message.

The user can then open the subagent session in the Tasks & Teams list to see
its work (loaded from the checkpointer via loadHistory).

Contrast with dispatch_to_team (multi-agent team) and dispatch_task
(teamleader's SYNCHRONOUS intra-team delegation).
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool, tool
from langchain_core.tools.base import InjectedToolArg
from pydantic import BaseModel, Field

from ..db import session_store
from ..single_runner import launch_single
from .roles import ROLES

logger = logging.getLogger(__name__)


class DispatchSingleInput(BaseModel):
    task_description: str = Field(
        description=(
            "The full task to hand off to the specialist. Be detailed: this is "
            "the only context the sub-agent receives. Include goals, file paths, "
            "constraints."
        )
    )
    target_agent: str = Field(
        description=(
            "Which specialist to delegate to: 'coder' (can read/edit/run files) "
            "or 'researcher' (read-only investigation)."
        )
    )


def make_dispatch_single_tool(*, agent_ref: Any) -> BaseTool:
    """Build the dispatch_single tool.

    ``agent_ref`` is the agent graph (or a dict holding it) that will run the
    sub-agent on an isolated thread. Typically the entry/default agent's graph,
    which carries the filesystem tools the coder/researcher need.
    """

    @tool("dispatch_single", args_schema=DispatchSingleInput)
    async def dispatch_single(
        task_description: str,
        target_agent: str,
        config: Annotated[RunnableConfig, InjectedToolArg],
    ) -> str:
        """Delegate a SINGLE clear task to one specialist sub-agent (async).

        Use this when a task needs exactly one specialist (e.g. "implement X"
        → coder, "investigate Y" → researcher). The sub-agent runs in the
        background; this returns immediately. The user can open the task in the
        Tasks & Teams list to watch it.

        Do NOT use this for multi-step tasks needing coordination between
        several specialists — use dispatch_to_team for those instead.
        """
        if target_agent not in ROLES:
            return (
                f"Unknown agent '{target_agent}'. Available: "
                f"{', '.join(ROLES.keys())}."
            )

        default_session_id = (
            (config or {}).get("configurable", {}).get("thread_id") or "unknown"
        )

        # Create the subagent session.
        child = await session_store.create(
            kind="subagent",
            name=target_agent,
            title=task_description[:60] or f"{target_agent} task",
            metadata={
                "role": target_agent,
                "allowed_tools": sorted(ROLES[target_agent]["allowed_tools"]),
                "parent": default_session_id,
            },
        )
        child_id = child["id"]
        await session_store.update(child_id, status="running")

        # Resolve the agent graph (dict indirection like dispatch_to_team).
        agent = agent_ref["agent"] if isinstance(agent_ref, dict) else agent_ref

        # Launch the sub-agent in the background (non-blocking).
        launch_single(
            agent=agent,
            session_id=child_id,
            role=target_agent,
            task_description=task_description,
            parent_session_id=default_session_id,
        )

        # Record the delegation edge.
        await session_store.add_link(
            from_session_id=default_session_id,
            to_session_id=child_id,
            direction="dispatch",
            content=task_description,
        )

        return (
            f"Delegated to {target_agent} (task {child_id[:12]}). The sub-agent "
            f"is now working on it in the background. Tell the user they can "
            f"open task {child_id[:12]} in the Tasks & Teams list to watch it."
        )

    return dispatch_single
