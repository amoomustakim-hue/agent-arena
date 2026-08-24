"""The Prediction Black Box — Python port of packages/arena-core/src/blackbox.ts.

One append-only, causally-linked event log per market. The properties that make
the TypeScript version work carry over unchanged, because they are what the
product IS, not an implementation detail of one language:

  1. APPEND-ONLY. A revised belief is a NEW event pointing back at the one it
     supersedes. Mutating in place would destroy the belief timeline.

  2. EXPLICIT CAUSALITY. Every event names the events that caused it via
     `caused_by`. Without that this is a chronology, not a flight recorder.

The two Black Boxes — this one and the TypeScript one — never talk to each
other directly. They agree on exactly one thing: the JSONL shape on disk. A
session written by the TS trading CLI and a session written by this Python
council are interchangeable files, which is what lets the (TypeScript)
reputation tools score sessions from either origin without caring which
process produced them.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Literal

AgentRole = Literal["bull", "bear", "forensics", "adversarial", "judge", "trader", "risk"]
EventId = str


@dataclass
class RecordedEvent:
    """One append-only entry. `kind` plus whatever fields that kind carries,
    stored as a flat dict in `data` so this file does not need one dataclass
    per event kind to stay in lockstep with the TypeScript union."""

    id: EventId
    seq: int
    ts: int
    kind: str
    caused_by: list[EventId]
    data: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        # Flattened on the wire: {id, seq, ts, kind, causedBy, ...data}. This
        # is the exact shape RecordedEvent.toJSONL() writes on the TS side —
        # matching it field-for-field is the whole interoperability contract.
        return {
            "id": self.id,
            "seq": self.seq,
            "ts": self.ts,
            "kind": self.kind,
            "causedBy": self.caused_by,
            **self.data,
        }

    @staticmethod
    def from_json(raw: dict[str, Any]) -> "RecordedEvent":
        core = {"id", "seq", "ts", "kind", "causedBy"}
        return RecordedEvent(
            id=raw["id"],
            seq=raw["seq"],
            ts=raw["ts"],
            kind=raw["kind"],
            caused_by=list(raw.get("causedBy", [])),
            data={k: v for k, v in raw.items() if k not in core},
        )


class BlackBox:
    """Append-only recorder. No querying, no indexes, no mutation — deliberately
    dumb, so a projection bug can never corrupt the record it reads."""

    def __init__(self, session_id: str, market_id: str) -> None:
        self.session_id = session_id
        self.market_id = market_id
        self._events: list[RecordedEvent] = []
        import time

        self._time = time

    def record(self, kind: str, data: dict[str, Any] | None = None, caused_by: list[EventId] | None = None) -> EventId:
        seq = len(self._events)
        ev = RecordedEvent(
            id=f"{self.session_id}:{seq}",
            seq=seq,
            ts=int(self._time.time() * 1000),
            kind=kind,
            caused_by=caused_by or [],
            data=data or {},
        )
        self._events.append(ev)
        return ev.id

    def all(self) -> list[RecordedEvent]:
        return list(self._events)

    def get(self, event_id: EventId) -> RecordedEvent | None:
        for e in self._events:
            if e.id == event_id:
                return e
        return None

    def at(self, seq: int) -> list[RecordedEvent]:
        return [e for e in self._events if e.seq <= seq]

    def to_jsonl(self) -> str:
        return "\n".join(json.dumps(e.to_json()) for e in self._events)

    def save(self, sessions_dir: Path) -> Path:
        sessions_dir.mkdir(parents=True, exist_ok=True)
        path = sessions_dir / f"{self.session_id}.jsonl"
        path.write_text(self.to_jsonl(), encoding="utf-8")
        return path

    @staticmethod
    def from_jsonl(text: str, session_id: str, market_id: str) -> "BlackBox":
        bb = BlackBox(session_id, market_id)
        for line in text.splitlines():
            if line.strip():
                bb._events.append(RecordedEvent.from_json(json.loads(line)))
        return bb


# --- projections ------------------------------------------------------------


def describe(e: RecordedEvent) -> str:
    """One-line human description, for causal annotations — mirrors the TS
    `describe()` switch statement kind for kind."""
    d = e.data
    if e.kind == "signal_captured":
        sig = d.get("signal", {})
        return f"{sig.get('label')} = {sig.get('value')}{sig.get('unit', '')} ({sig.get('origin')})"
    if e.kind == "challenge_issued":
        return f"{d.get('from')} challenged {d.get('against')}: {d.get('claim')}"
    if e.kind == "belief_stated":
        belief = d.get("belief", {})
        return f"{belief.get('agent')} opened at {belief.get('p', 0) * 100:.0f}%"
    if e.kind == "belief_revised":
        belief = d.get("belief", {})
        return f"{belief.get('agent')} moved {d.get('from', 0) * 100:.0f}% → {belief.get('p', 0) * 100:.0f}%"
    if e.kind == "market_observed":
        mid = d.get("yesMid")
        return f"market {d.get('symbol')} @ {f'{mid * 100:.0f}%' if mid is not None else 'no book'}"
    return e.kind


def belief_timeline(bb: BlackBox, agent: AgentRole) -> list[dict[str, Any]]:
    """71% -> 64% -> 58% -> 63%, each step annotated with what caused it."""
    out: list[dict[str, Any]] = []
    for e in bb.all():
        if e.kind == "belief_stated" and e.data.get("belief", {}).get("agent") == agent:
            out.append({"seq": e.seq, "ts": e.ts, "p": e.data["belief"]["p"], "because": "opening thesis", "eventId": e.id})
        elif e.kind == "belief_revised" and e.data.get("belief", {}).get("agent") == agent:
            causes = [bb.get(cid) for cid in e.caused_by]
            causes = [c for c in causes if c is not None]
            because = "; ".join(describe(c) for c in causes) if causes else e.data["belief"].get("rationale", "")
            out.append({"seq": e.seq, "ts": e.ts, "p": e.data["belief"]["p"], "because": because, "eventId": e.id})
    return out


def counterfactual(bb: BlackBox, remove_id: EventId) -> dict[str, Any]:
    """Drop one event and everything causally downstream. Structural, not a
    re-run — shows what DEPENDED on the removed node."""
    dead = {remove_id}
    for e in bb.all():
        if any(c in dead for c in e.caused_by):
            dead.add(e.id)
    surviving = [e for e in bb.all() if e.id not in dead]
    return {
        "removed": list(dead),
        "surviving": surviving,
        "verdictSurvives": any(e.kind == "verdict" for e in surviving),
    }


def brier(p: float, outcome: Literal["YES", "NO"]) -> float:
    actual = 1.0 if outcome == "YES" else 0.0
    return (p - actual) ** 2


def revision_quality(bb: BlackBox, agent: AgentRole, outcome: Literal["YES", "NO"]) -> dict[str, int]:
    tl = belief_timeline(bb, agent)
    target = 1.0 if outcome == "YES" else 0.0
    helpful = 0
    for i in range(1, len(tl)):
        before = abs(tl[i - 1]["p"] - target)
        after = abs(tl[i]["p"] - target)
        if after < before:
            helpful += 1
    return {"revisions": max(0, len(tl) - 1), "helpful": helpful}
