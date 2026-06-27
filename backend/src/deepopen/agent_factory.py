"""Build the two agents: default (entry) + teamleader (team coordinator).

- **default**: the entry agent the user talks to. It can do simple things
  directly, OR delegate a large task to a background team via dispatch_to_team
  (non-blocking).
- **teamleader**: runs inside a team session, coordinates sub-agents via the
  synchronous dispatch_task (researcher/coder). Each delegation creates an
  isolated child session + message_links.

Both share the same model + filesystem backend + checkpointer.
"""

from __future__ import annotations

from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import LocalShellBackend
from langchain_core.language_models import BaseChatModel
from langchain_anthropic import ChatAnthropic
from langchain_openai import ChatOpenAI
from langgraph.graph.state import CompiledStateGraph

from .config import settings
from .store import get_checkpointer
from .tools import make_dispatch_task_tool, make_dispatch_to_team_tool

DEFAULT_PROMPT = f"""{settings.system_prompt}

You are the DEFAULT entry agent. The user talks to you first.
- For simple, quick tasks (answer a question, read/edit one file), just do it
  yourself with the file system tools.
- For LARGER or multi-step tasks that benefit from a team of specialists, use
  the `dispatch_to_team` tool to hand the task off to a background team. It
  returns immediately; tell the user they can open the team chat in the
  sidebar to watch progress.
"""


TEAMLEADER_PROMPT = """You are a TEAM LEADER coordinating a team of specialist
sub-agents to complete a task handed to you.

Your sub-agents (via the `dispatch_task` tool):
- "researcher": read-only investigation (list/read/grep files). Use to explore
  the codebase, answer "what's there" questions.
- "coder": can read/write/edit/run files. Use to implement changes.

How to work:
1. Break the task into subtasks.
2. Delegate each subtask with dispatch_task, giving a CLEAR, DETAILED
   description (the sub-agent starts with no context — include file paths,
   goals, constraints).
3. Review results; delegate follow-ups if needed.
4. When done, write a concise final summary for the user.

Keep delegating until the task is complete. Prefer delegating over doing the
work yourself.
"""


def _build_model() -> BaseChatModel:
    provider = settings.model_provider.lower()
    if provider == "anthropic":
        return ChatAnthropic(
            model=settings.model,
            api_key=settings.anthropic_api_key,
            base_url=settings.anthropic_base_url,
            streaming=True,
            max_tokens=8192,
        )
    return ChatOpenAI(
        model=settings.model,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        streaming=True,
    )


def _build_backend(workdir: str) -> LocalShellBackend:
    return LocalShellBackend(
        root_dir=workdir,
        virtual_mode=False,
        inherit_env=True,
    )


async def _build_default_agent(
    workdir: str, checkpointer: Any, model: BaseChatModel
) -> CompiledStateGraph:
    """Build the default + teamleader agents bound to a specific workdir.

    The teamleader is created first and held by an indirect ref so the default
    agent's dispatch_to_team tool can launch it in the background.
    """
    backend = _build_backend(workdir)

    # teamleader (coordinates sub-agents via dispatch_task)
    team_agent_ref: dict = {}
    dispatch_task_tool = make_dispatch_task_tool(
        agent_ref=team_agent_ref, parent_workdir=workdir
    )
    teamleader = create_deep_agent(
        model=model,
        system_prompt=TEAMLEADER_PROMPT,
        tools=[dispatch_task_tool],
        backend=backend,
        checkpointer=checkpointer,
        name="deepopen-teamleader",
    )
    team_agent_ref["agent"] = teamleader

    # default (entry agent, delegates to teams)
    dispatch_to_team_tool = make_dispatch_to_team_tool(team_agent_ref=teamleader)
    default_agent = create_deep_agent(
        model=model,
        system_prompt=DEFAULT_PROMPT,
        tools=[dispatch_to_team_tool],
        backend=backend,
        checkpointer=checkpointer,
        name="deepopen-default",
    )
    return default_agent


# Per-workdir agent cache: workdir -> (default_agent, teamleader_agent).
# Agents are cheap to build but we avoid rebuilding on every request; a session
# reuses the cached agent for its workdir.
_agent_cache: dict[str, tuple] = {}
_default_checkpointer: Any = None
_default_model: BaseChatModel | None = None


async def get_agent_for_workdir(workdir: str) -> CompiledStateGraph:
    """Return the default agent bound to ``workdir`` (cached, built on demand).

    This enables per-session workdirs: each distinct workdir gets its own agent
    instance (with its own filesystem backend rooted there).
    """
    global _default_checkpointer, _default_model
    if _default_checkpointer is None:
        _default_checkpointer = await get_checkpointer()
    if _default_model is None:
        _default_model = _build_model()

    if workdir not in _agent_cache:
        _agent_cache[workdir] = await _build_default_agent(
            workdir, _default_checkpointer, _default_model
        )
    return _agent_cache[workdir]  # the default agent


async def build_agents() -> tuple[CompiledStateGraph, CompiledStateGraph]:
    """Build both agents at startup (for the configured default workdir).

    Returns (default_agent, teamleader_agent). The default agent holds an
    indirect ref to the teamleader (via dispatch_to_team -> team_runner).
    """
    checkpointer = await get_checkpointer()
    model = _build_model()

    # teamleader: coordinates sub-agents via dispatch_task ---------------
    team_agent_ref: dict = {}
    dispatch_task_tool = make_dispatch_task_tool(
        agent_ref=team_agent_ref, parent_workdir=settings.workdir
    )
    teamleader = create_deep_agent(
        model=model,
        system_prompt=TEAMLEADER_PROMPT,
        tools=[dispatch_task_tool],
        backend=_build_backend(settings.workdir),
        checkpointer=checkpointer,
        name="deepopen-teamleader",
    )
    team_agent_ref["agent"] = teamleader

    # default: entry agent, delegates to teams via dispatch_to_team ------
    dispatch_to_team_tool = make_dispatch_to_team_tool(team_agent_ref=teamleader)
    default_agent = create_deep_agent(
        model=model,
        system_prompt=DEFAULT_PROMPT,
        tools=[dispatch_to_team_tool],
        backend=_build_backend(settings.workdir),
        checkpointer=checkpointer,
        name="deepopen-default",
    )

    # warm the cache for the default workdir (store the default agent)
    _agent_cache[settings.workdir] = default_agent
    _default_checkpointer = checkpointer
    _default_model = model

    return default_agent, teamleader
