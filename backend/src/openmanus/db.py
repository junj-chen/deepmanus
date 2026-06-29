"""Session storage: the metadata/graph layer over the checkpointer.

Two SQLite tables model the agent collaboration graph:

* ``sessions``      — nodes: each agent/conversation (root, team, subagent).
* ``message_links`` — directed edges: who dispatched/returned what to whom.

This lives in its own DB file (``sessions.db``) separate from the LangGraph
checkpointer's ``checkpoints.db`` — the checkpointer stores message *content*,
this stores *who-is-who and how they relate* (metadata + graph).

Inspired by Claude Code (isolated agent contexts + resumable agentId) and
OpenClaw (per-agent workdir, auditable delegate actions).
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import aiosqlite

from .config import settings


def _db_path() -> str:
    """Sessions DB path, derived from DATABASE_URL (kept next to checkpoints)."""
    url = settings.database_url
    path = url
    for prefix in ("sqlite:///", "sqlite://"):
        if path.startswith(prefix):
            path = path[len(prefix):]
            break
    # checkpoints.db -> sessions.db (same dir)
    p = Path(path)
    return str(p.with_name("sessions.db"))


_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL DEFAULT 'root',
    name        TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    title       TEXT,
    model       TEXT,
    workdir     TEXT,
    metadata    TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS message_links (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    from_session_id TEXT NOT NULL REFERENCES sessions(id),
    to_session_id   TEXT NOT NULL REFERENCES sessions(id),
    direction       TEXT NOT NULL DEFAULT 'chat',
    content         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_links_from ON message_links(from_session_id);
CREATE INDEX IF NOT EXISTS idx_links_to   ON message_links(to_session_id);
"""


async def init_db() -> None:
    """Create tables if missing. Called once at app startup."""
    Path(_db_path()).parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(_db_path()) as db:
        await db.executescript(_SCHEMA)
        await db.commit()


def _row_to_session(row: aiosqlite.Row) -> dict[str, Any]:
    d = dict(row)
    try:
        d["metadata"] = json.loads(d.get("metadata") or "{}")
    except (TypeError, ValueError):
        d["metadata"] = {}
    return d


class SessionStore:
    """Async CRUD + graph queries for sessions and their message links."""

    async def _db(self) -> aiosqlite.Connection:
        db = await aiosqlite.connect(_db_path())
        db.row_factory = aiosqlite.Row
        return db

    async def create(
        self,
        *,
        kind: str = "root",
        name: str | None = None,
        title: str | None = None,
        model: str | None = None,
        workdir: str | None = None,
        metadata: dict | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        sid = session_id or f"sess-{uuid.uuid4().hex}"
        async with aiosqlite.connect(_db_path()) as db:
            await db.execute(
                """INSERT INTO sessions (id, kind, name, title, model, workdir, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    sid,
                    kind,
                    name,
                    title,
                    model or settings.model,
                    workdir or settings.workdir,
                    json.dumps(metadata or {}, ensure_ascii=False),
                ),
            )
            await db.commit()
        return await self.get(sid) or {"id": sid}

    async def get(self, session_id: str) -> dict[str, Any] | None:
        async with aiosqlite.connect(_db_path()) as db:
            db.row_factory = aiosqlite.Row
            cur = await db.execute(
                "SELECT * FROM sessions WHERE id = ?", (session_id,)
            )
            row = await cur.fetchone()
            return _row_to_session(row) if row else None

    async def ensure_default(self) -> dict[str, Any]:
        """Ensure the permanent default entry session exists; create if absent.

        Uses a fixed id ("default") so the entry is a singleton: always present,
        never deleted. "New chat" resets its history (clears the checkpointer
        thread), it does NOT create a second default. Idempotent across restarts.
        Also refreshes the title on each boot so a brand rename (e.g. "Default
        Agent" → "Manus") propagates to existing rows without wiping data.
        """
        existing = await self.get("default")
        if existing:
            if existing.get("title") != "Manus":
                return await self.update("default", title="Manus")
            return existing
        return await self.create(session_id="default", kind="root", title="Manus")

    async def ensure_exists(
        self, session_id: str, *, title: str | None = None
    ) -> dict[str, Any]:
        """Ensure a session with the given id exists; create if absent."""
        existing = await self.get(session_id)
        if existing:
            return existing
        return await self.create(session_id=session_id, kind="root", title=title)

    async def list(self, kind: str | None = None) -> list[dict[str, Any]]:
        async with aiosqlite.connect(_db_path()) as db:
            db.row_factory = aiosqlite.Row
            if kind:
                cur = await db.execute(
                    "SELECT * FROM sessions WHERE kind = ? ORDER BY updated_at DESC",
                    (kind,),
                )
            else:
                cur = await db.execute(
                    "SELECT * FROM sessions ORDER BY updated_at DESC"
                )
            rows = await cur.fetchall()
            return [_row_to_session(r) for r in rows]

    async def update(
        self,
        session_id: str,
        *,
        title: str | None = None,
        status: str | None = None,
        workdir: str | None = None,
        metadata: dict | None = None,
        touch: bool = True,
    ) -> dict[str, Any] | None:
        sets: list[str] = []
        params: list[Any] = []
        if title is not None:
            sets.append("title = ?")
            params.append(title)
        if status is not None:
            sets.append("status = ?")
            params.append(status)
        if workdir is not None:
            sets.append("workdir = ?")
            params.append(workdir)
        if metadata is not None:
            sets.append("metadata = ?")
            params.append(json.dumps(metadata, ensure_ascii=False))
        if touch:
            sets.append("updated_at = datetime('now')")
        if not sets:
            return await self.get(session_id)
        params.append(session_id)
        async with aiosqlite.connect(_db_path()) as db:
            await db.execute(
                f"UPDATE sessions SET {', '.join(sets)} WHERE id = ?", params
            )
            await db.commit()
        return await self.get(session_id)

    async def delete(self, session_id: str) -> bool:
        async with aiosqlite.connect(_db_path()) as db:
            cur = await db.execute(
                "DELETE FROM sessions WHERE id = ?", (session_id,)
            )
            await db.execute(
                "DELETE FROM message_links WHERE from_session_id = ? OR to_session_id = ?",
                (session_id, session_id),
            )
            await db.commit()
            return cur.rowcount > 0

    async def add_link(
        self,
        *,
        from_session_id: str,
        to_session_id: str,
        direction: str = "chat",
        content: str | None = None,
    ) -> None:
        async with aiosqlite.connect(_db_path()) as db:
            await db.execute(
                """INSERT INTO message_links
                   (from_session_id, to_session_id, direction, content)
                   VALUES (?, ?, ?, ?)""",
                (from_session_id, to_session_id, direction, content),
            )
            await db.commit()

    async def get_graph(self, session_id: str) -> dict[str, Any]:
        """Return the collaboration graph reachable from a session.

        Walks the message_links edges (both directions) to collect all related
        sessions, then returns {nodes, links} shaped for reactflow rendering.
        """
        async with aiosqlite.connect(_db_path()) as db:
            db.row_factory = aiosqlite.Row
            # Collect all sessions directly linked to the root (1-hop).
            cur = await db.execute(
                """SELECT DISTINCT s.* FROM sessions s
                   LEFT JOIN message_links l
                     ON s.id = l.from_session_id OR s.id = l.to_session_id
                   WHERE l.from_session_id = ? OR l.to_session_id = ? OR s.id = ?""",
                (session_id, session_id, session_id),
            )
            rows = await cur.fetchall()
            cur = await db.execute(
                """SELECT * FROM message_links
                   WHERE from_session_id IN (
                       SELECT id FROM sessions WHERE id = ?
                       UNION
                       SELECT to_session_id FROM message_links WHERE from_session_id = ?
                   )""",
                (session_id, session_id),
            )
            link_rows = await cur.fetchall()

        nodes = [
            {
                "id": r["id"],
                "data": {
                    "label": r["name"] or r["title"] or r["id"],
                    "kind": r["kind"],
                    "status": r["status"],
                },
            }
            for r in rows
        ]
        links = [
            {
                "id": str(r["id"]),
                "source": r["from_session_id"],
                "target": r["to_session_id"],
                "label": r["direction"],
                "data": {"content": r["content"], "direction": r["direction"]},
            }
            for r in link_rows
        ]
        return {"nodes": nodes, "links": links}


# Module-level singleton (created once; cheap to reconnect per-op with aiosqlite).
session_store = SessionStore()
