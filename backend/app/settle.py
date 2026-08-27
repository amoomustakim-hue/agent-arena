"""Settle one council session and score every agent that stated a belief.

Python port of `arena-trade/src/settle.ts`'s `scoreSession()` — reads the
outcome from chain via the trading MCP server (which has no belief history
of its own), then scores against THIS session's own Black Box, since the
belief history only exists here, in the FastAPI process that ran the council.

Two rules carried over unchanged from the TS side, because they are what
keeps the numbers honest rather than an implementation detail:

  - A market that has not resolved scores NOBODY. An unsettled forecast is
    not a result.
  - A VOIDED market scores nobody either. The agents were not wrong; the
    question was withdrawn.
"""

from __future__ import annotations

from typing import Any, Literal

from .blackbox import BlackBox, EventId, brier, revision_quality

Outcome = Literal["YES", "NO", "VOID"]


def score_session(bb: BlackBox, outcome: Outcome, caused_by: list[EventId] | None = None) -> list[dict[str, Any]]:
    if outcome == "VOID":
        return []

    openings: dict[str, float] = {}
    finals: dict[str, float] = {}
    for e in bb.all():
        if e.kind == "belief_stated":
            agent = e.data["belief"]["agent"]
            openings.setdefault(agent, e.data["belief"]["p"])
            finals[agent] = e.data["belief"]["p"]
        elif e.kind == "belief_revised":
            agent = e.data["belief"]["agent"]
            finals[agent] = e.data["belief"]["p"]

    rows: list[dict[str, Any]] = []
    for agent, p in finals.items():
        rq = revision_quality(bb, agent, outcome)  # type: ignore[arg-type]
        row = {
            "agent": agent,
            "p": p,
            "p0": openings.get(agent, p),
            "brier": brier(p, outcome),  # type: ignore[arg-type]
            "correct": (p > 0.5) == (outcome == "YES"),
            "revisions": rq["revisions"],
            "revisionsHelpful": rq["helpful"],
        }
        rows.append(row)
        bb.record(
            "scored",
            {
                "agent": agent,
                "p": row["p"],
                "brier": row["brier"],
                "correct": row["correct"],
                "revisions": row["revisions"],
                "revisionsHelpful": row["revisionsHelpful"],
            },
            caused_by or [],
        )
    return rows
