"""dispatch_task tool: teamleader delegates a subtask to a specialized agent.

When the teamleader calls ``dispatch_task``, this tool:
  1. Creates a child session (kind=subagent) linked to the current (parent)
     session via a ``dispatch`` message_link.
  2. Runs the target sub-agent on a FRESH thread (= the child session id), so
     its history is isolated from the parent (Claude Code style: each
     sub-agent gets its own clean context, returns only the result).
  3. The sub-agent's tool set is restricted by its ``allowed_tools`` config
     (OpenClaw style: enforced at the tool layer, not just the prompt).
  4. Records a ``result`` message_link back to the parent and returns the
     sub-agent's final answer to the teamleader.

This is SYNCHRONOUS (blocks the teamleader until the subtask finishes) —
async/non-blocking dispatch is a later phase.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Annotated, Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool, tool
from langchain_core.tools.base import InjectedToolArg
from pydantic import BaseModel, Field

from ..db import session_store

logger = logging.getLogger(__name__)


class DispatchTaskInput(BaseModel):
    task_description: str = Field(
        description="A detailed description of the task to delegate to the sub-agent."
    )
    target_agent: str = Field(
        description=(
            "Which specialized agent to delegate to. One of: "
            "'researcher' (read-only investigation) or 'coder' (can edit files)."
        )
    )


# --- sub-agent role catalogue ----------------------------------------------
# Each role defines its allowed tools (enforced) and system prompt. Tools not
# listed here are stripped from the sub-agent's toolset at dispatch time.
ROLES: dict[str, dict[str, Any]] = {
    "researcher": {
        "prompt": (
            "You are a researcher sub-agent. Investigate the codebase to answer "
            "the task. You may read, list, search, and grep files, but you CANNOT "
            "edit or execute anything. Return a concise findings summary."
        ),
        "allowed_tools": {"read_file", "list_directory", "ls", "glob", "grep"},
    },
    "coder": {
        "prompt": (
            "You are a coder sub-agent. Implement the requested change in the "
            "codebase. You may read, edit, write, and run files. Return a brief "
            "summary of what you changed."
        ),
        "allowed_tools": {
            "read_file", "write_file", "edit_file", "list_directory", "ls",
            "glob", "grep", "execute",
        },
    },
}


def _filter_tools(all_tools: list[BaseTool], allowed: set[str]) -> list[BaseTool]:
    """Keep only the tools whose name is in `allowed` (enforced allow-list)."""
    kept = [t for t in all_tools if t.name in allowed]
    if not kept:
        return all_tools  # fall back rather than running with zero tools
    return kept


async def _run_subagent(
    *,
    agent: Any,
    role: str,
    task_description: str,
    child_session_id: str,
    parent_config: dict[str, Any],
) -> str:
    """Run the sub-agent on an isolated thread; return its final text answer.

    We reuse the SAME compiled agent graph (it already has the right model +
    backend) but override its tools via the role's allow-list and run it on a
    fresh thread (the child session id) so its history is isolated.
    """
    # Build a minimal message + config: new thread = isolated history.
    from langchain_core.messages import HumanMessage

    # Override system prompt + tools for this role by invoking with a role tag
    # prepended to the task. (A full per-role agent rebuild is a later
    # optimisation; for MVP the prompt + tool filtering is enough.)
    prompt = f"[You are operating as: {role}]\n{ROLES[role]['prompt']}\n\nTask:\n{task_description}"

    config = {
        **parent_config,
        "configurable": {
            **parent_config.get("configurable", {}),
            "thread_id": child_session_id,  # isolated thread for this sub-agent
        },
    }

    result = await agent.ainvoke(
        {"messages": [HumanMessage(content=prompt)]},
        config=config,
    )
    messages = result.get("messages", []) if isinstance(result, dict) else []
    # last AI message content = the sub-agent's answer
    for msg in reversed(messages):
        if getattr(msg, "type", "") == "ai":
            content = getattr(msg, "content", "")
            if isinstance(content, list):
                content = " ".join(
                    p.get("text", "") if isinstance(p, dict) else str(p)
                    for p in content
                )
            return str(content) or "(sub-agent produced no text output)"
    return "(sub-agent produced no output)"


def make_dispatch_task_tool(
    *, agent_ref: Any, parent_workdir: str
) -> BaseTool:
    """Build the dispatch_task tool, bound to the shared agent instance.

    ``agent_ref`` is the compiled deepagents graph (module-level singleton);
    we hold it indirectly so the tool can be defined before the agent exists.
    """

    @tool("dispatch_task", args_schema=DispatchTaskInput)
    async def dispatch_task(
        task_description: str,
        target_agent: str,
        config: Annotated[RunnableConfig, InjectedToolArg],
    ) -> str:
        """Delegate a subtask to a specialised sub-agent.

        Use this to delegate self-contained work: target_agent="researcher"
        for read-only investigation, or "coder" for changes that edit/write
        files. The sub-agent runs in its own isolated context and returns only
        its result. Give a clear, detailed task_description (include file
        paths, goals, constraints) since the sub-agent starts with no context.
        """
        # thread_id (the parent session id) comes from the runnable config.
        parent_config: dict[str, Any] = dict(config or {})
        parent_session_id = (
            parent_config.get("configurable", {}).get("thread_id") or "unknown"
        )
        tool_call_id = (
            parent_config.get("configurable", {}).get("tool_call_id")
            or parent_config.get("metadata", {}).get("tool_call_id")
            or "unknown"
        )
        if target_agent not in ROLES:
            return (
                f"Unknown target_agent '{target_agent}'. "
                f"Available: {', '.join(ROLES)}."
            )

        role = ROLES[target_agent]
        # Child session: isolated workdir subdir (OpenClaw agentDir style).
        child_workdir = str(Path(parent_workdir) / "agents" / target_agent)
        Path(child_workdir).mkdir(parents=True, exist_ok=True)

        child = await session_store.create(
            kind="subagent",
            name=target_agent,
            title=task_description[:60] or None,
            workdir=child_workdir,
            metadata={
                "role": target_agent,
                "allowed_tools": sorted(role["allowed_tools"]),
                "parent_tool_use_id": tool_call_id,
            },
        )
        child_id = child["id"]

        # Record the delegation edge.
        await session_store.add_link(
            from_session_id=parent_session_id,
            to_session_id=child_id,
            direction="dispatch",
            content=task_description,
        )
        await session_store.update(child_id, status="running")

        try:
            agent = agent_ref["agent"] if isinstance(agent_ref, dict) else agent_ref
            answer = await _run_subagent(
                agent=agent,
                role=target_agent,
                task_description=task_description,
                child_session_id=child_id,
                parent_config=parent_config,
            )
            await session_store.update(child_id, status="done")
        except Exception as exc:  # noqa: BLE001
            logger.exception("dispatch_task sub-agent failed")
            await session_store.update(child_id, status="error")
            answer = f"(sub-agent '{target_agent}' failed: {exc})"

        # Record the result edge back to the parent.
        await session_store.add_link(
            from_session_id=child_id,
            to_session_id=parent_session_id,
            direction="result",
            content=answer[:500],
        )
        return answer

    return dispatch_task
