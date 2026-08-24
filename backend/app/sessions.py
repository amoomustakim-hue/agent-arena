"""In-memory registry of council sessions.

Deliberately not a database. A council session lives for one contract window
— minutes, not days — and the durable artifact is the Black Box JSONL written
to disk on completion (see agents.cli / this module's `_run`). This registry
exists only to let a WebSocket client attach to a run that is already in
progress and replay what it missed.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

from .blackbox import BlackBox, RecordedEvent

log = logging.getLogger("arena.sessions")


@dataclass
class Session:
    session_id: str
    market_id: str
    blackbox: BlackBox
    status: str = "running"  # running | done | error
    error: str | None = None
    outcome: dict[str, Any] | None = None
    listeners: list[WebSocket] = field(default_factory=list)
    task: asyncio.Task | None = None


_sessions: dict[str, Session] = {}


def create(session_id: str, market_id: str) -> Session:
    s = Session(session_id=session_id, market_id=market_id, blackbox=BlackBox(session_id, market_id))
    _sessions[session_id] = s
    return s


def get(session_id: str) -> Session | None:
    return _sessions.get(session_id)


def list_active() -> list[Session]:
    return list(_sessions.values())


async def broadcast_event(session: Session, event: RecordedEvent) -> None:
    """Push one Black Box event to every attached client.

    A dead socket must not take the others down with it, and must not stop
    the council itself — a UI disconnecting is not a reason to abort a
    council that a trade proposal may depend on finishing.
    """
    payload = {"type": "event", "event": event.to_json()}
    dead: list[WebSocket] = []
    for ws in session.listeners:
        try:
            await ws.send_json(payload)
        except Exception:  # noqa: BLE001
            dead.append(ws)
    for ws in dead:
        session.listeners.remove(ws)


async def broadcast_progress(session: Session, progress: dict) -> None:
    payload = {"type": "progress", **progress}
    dead: list[WebSocket] = []
    for ws in session.listeners:
        try:
            await ws.send_json(payload)
        except Exception:  # noqa: BLE001
            dead.append(ws)
    for ws in dead:
        session.listeners.remove(ws)
