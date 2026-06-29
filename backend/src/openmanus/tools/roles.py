"""Sub-agent role catalogue, shared by dispatch_task and dispatch_single.

Each role defines a system prompt (steers the sub-agent's behaviour) and the
allowed_tools set (intended to be enforced; today applied via prompt only).
"""

from __future__ import annotations

from typing import Any

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
            "read_file",
            "write_file",
            "edit_file",
            "list_directory",
            "ls",
            "glob",
            "grep",
            "execute",
        },
    },
}


def role_prompt(role: str) -> str:
    """The system prompt for a role, or a sensible default if unknown."""
    cfg = ROLES.get(role)
    return cfg["prompt"] if cfg else (
        f"You are a {role} sub-agent. Complete the task. Return a brief summary."
    )
