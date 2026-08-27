"""The council, as a LangGraph StateGraph.

One market, six seats, one causally-linked Black Box record — orchestrated the
same way as `packages/arena-agents/src/council.ts`, in Python, over a graph
instead of a hand-rolled async pipeline. The order is the product, not an
implementation detail:

  observe -> capture evidence -> Bull/Bear/Risk open BLIND and CONCURRENTLY ->
  mechanical audit (over MCP) -> LLM challenges -> responses -> verdict -> edge

Two things this file does NOT do, deliberately:

  - It does not re-derive signal extraction or citation auditing. Both already
    exist, tested, in TypeScript, and are reached over MCP (see llm.audit and
    venue.evidence). Python orchestrates; TypeScript owns venue logic exactly
    once. Re-implementing either here would be a second, driftable copy of
    logic that already works.

  - It does not let Bull and Bear see each other before both commit. They run
    inside one `asyncio.gather`, and neither result is read until both land —
    the same rule as the TS version, for the same reason: reading one before
    the other turns "disagreement" into an anchoring artifact.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, TypedDict

from langgraph.graph import END, StateGraph

from ..blackbox import BlackBox, EventId
from ..venue import Venue
from . import llm
from .personas import (
    ADVERSARIAL,
    BEAR,
    BULL,
    CHALLENGERS,
    FORENSICS,
    HOUSE_RULES,
    JUDGE,
    OPENERS,
    RISK,
    TARGETS,
    AgentSpec,
    is_directional,
)
from .schemas import Belief, Challenge, Response, Verdict

DEFAULT_BUDGET_S = 300.0
RESERVE_JUDGE = 45.0
RESERVE_RESPOND = 45.0
RESERVE_CHALLENGE = 35.0


def pct(p: float) -> str:
    return f"{p * 100:.1f}%"


def render_belief(role: str, b: Belief) -> str:
    cites = ", ".join(b.cites) if b.cites else "(nothing)"
    return f'{role.upper()} — P(YES) = {b.p:.3f} ({pct(b.p)}), confidence {b.confidence:.2f}\n  cites: {cites}\n  "{b.rationale}"'


def render_findings(findings: list[dict]) -> str:
    if not findings:
        return "  (none — every cited id was captured, and none is stale or circular)"
    lines = []
    for f in findings:
        sids = f", (signals: {', '.join(f['signal_ids'])})" if f.get("signal_ids") else ""
        lines.append(f"  [{f['severity'].upper()}] {f['claim']}{sids}")
    return "\n".join(lines)


def render_challenges(cs: list[dict]) -> str:
    if not cs:
        return "  (none)"
    lines = []
    for i, c in enumerate(cs, 1):
        who = "the mechanical audit" if c.get("mechanical") else c["from"]
        lines.append(f"  [{i}] from {who} — severity {c['severity'].upper()}\n      {c['claim']}")
        if c.get("cites"):
            lines.append(f"      (signals: {', '.join(c['cites'])})")
    return "\n".join(lines)


class Budget:
    """Wall-clock governor. Mirrors council.ts's Budget: a deadline, and
    `affords()` to check there is room for a phase on top of what later
    phases have reserved."""

    def __init__(self, seconds: float) -> None:
        self.deadline = time.monotonic() + seconds

    def left(self) -> float:
        return self.deadline - time.monotonic()

    def affords(self, cost: float, reserved: float) -> bool:
        return self.left() >= cost + reserved


async def with_deadline(coro, seconds: float, label: str):
    try:
        return await asyncio.wait_for(coro, timeout=max(0.0, seconds))
    except asyncio.TimeoutError as e:
        raise TimeoutError(f"ran out of wall clock during: {label}") from e


class CouncilState(TypedDict, total=False):
    market_id: str
    market_text: str
    evidence_text: str
    signals: list[dict]
    market_implied: float | None
    budget: Budget
    blackbox: BlackBox
    signal_event_ids: dict[str, EventId]
    market_event_id: EventId
    openings: dict[str, dict[str, Any]]
    challenges: list[dict[str, Any]]
    resolutions: dict[str, dict[str, Any]]
    final_p: dict[str, float]
    verdict: Verdict | None
    verdict_event_id: EventId | None
    edge: float | None
    skipped: list[str]
    on_progress: Callable[[dict], None] | None
    on_event: Callable[[Any], None] | None


def _emit(state: CouncilState, phase: str, detail: str) -> None:
    cb = state.get("on_progress")
    if cb:
        cb({"phase": phase, "detail": detail, "sLeft": state["budget"].left()})


def _record_skip(state: CouncilState, key: str, why: str) -> None:
    state.setdefault("skipped", []).append(why)
    state["blackbox"].record(
        "signal_captured",
        {
            "signal": {
                "id": key,
                "label": "Council phase skipped",
                "value": "SKIPPED",
                "origin": "clock",
                "observedAt": int(time.time()),
                "staleness": 0,
                "source": why,
            }
        },
        [state["market_event_id"]],
    )


# --- nodes -------------------------------------------------------------


async def node_observe(state: CouncilState) -> dict:
    bb = state["blackbox"]
    _emit(state, "observe", state["market_id"])

    market_event_id = bb.record(
        "market_observed",
        {
            "marketId": state["market_id"],
            "symbol": state["market_id"],
            "yesMid": state.get("market_implied"),
        },
    )
    signal_event_ids: dict[str, EventId] = {}
    for s in state["signals"]:
        # The MCP evidence tool renders two SECTION headers (independent /
        # circular) but never a per-signal origin string, so this is all the
        # granularity venue.py's parser can recover — "book" vs "underlying",
        # not the full five-way SignalOrigin union the TS side has. That's a
        # real loss of detail, but it preserves the one property the whole
        # war room UI actually depends on: isCircular() on the frontend keys
        # off exactly "book"/"derived" vs "underlying"/"chain"/"clock", and
        # the literal string "circular" is not a member of that union at all
        # — it would have silently rendered every circular signal from a live
        # Python session as independent, which is the one distinction this
        # product cannot afford to get backwards.
        origin = "book" if s["circular"] else "underlying"
        eid = bb.record(
            "signal_captured",
            {"signal": {"id": s["id"], "label": s["label"], "value": s["value"], "origin": origin, "staleness": s.get("staleness", 0)}},
            [market_event_id],
        )
        signal_event_ids[s["id"]] = eid
    _emit(state, "observe", f"{len(state['signals'])} signals captured")
    return {"market_event_id": market_event_id, "signal_event_ids": signal_event_ids, "skipped": []}


async def _open_one(spec: AgentSpec, state: CouncilState) -> dict:
    prompt = (
        f"{state['market_text']}\n\nEVIDENCE\n{state['evidence_text']}\n\n"
        f"You are the {spec.role.upper()} agent. {spec.persona}\n\n"
        "State your probability that YES settles true, and cite the signal ids you used."
    )
    belief = await with_deadline(
        llm.ask(Belief, f"{HOUSE_RULES}\n\n{spec.persona}", prompt),
        state["budget"].left() - RESERVE_JUDGE,
        f"{spec.role} opening",
    )
    causes = [state["signal_event_ids"][c] for c in belief.cites if c in state["signal_event_ids"]]
    event_id = state["blackbox"].record(
        "belief_stated",
        {"belief": {"agent": spec.role, **belief.model_dump()}},
        causes,
    )
    return {"spec": spec, "belief": belief, "event_id": event_id}


async def node_open(state: CouncilState, venue: Venue) -> dict:
    _emit(state, "open", "bull, bear, risk (concurrent, blind)")

    async def guarded(spec: AgentSpec):
        try:
            return await _open_one(spec, state)
        except Exception as e:  # noqa: BLE001
            return e

    bull_r, bear_r, risk_r = await asyncio.gather(
        guarded(BULL), guarded(BEAR), guarded(RISK)
    )

    openings: dict[str, dict] = {}
    skipped: list[str] = []
    for spec, result in [(BULL, bull_r), (BEAR, bear_r), (RISK, risk_r)]:
        if isinstance(result, Exception):
            skipped.append(f"{spec.role} opening failed: {result}")
            if spec.role != "risk":
                raise result  # Bull/Bear are load-bearing; Risk is advisory only.
            continue
        openings[spec.role] = result

    final_p = {role: o["belief"].p for role, o in openings.items()}
    _emit(state, "open", "  ".join(f"{r} {pct(p)}" for r, p in final_p.items()))
    return {"openings": openings, "final_p": final_p, "skipped": state.get("skipped", []) + skipped}


async def node_audit(state: CouncilState, venue: Venue) -> dict:
    _emit(state, "audit", "auditCitations over every opening belief (via MCP)")
    challenges: list[dict] = []
    for role, o in state["openings"].items():
        if role == "risk":
            continue
        result = await llm.audit(venue, state["market_id"], o["belief"].cites, directional=is_directional(role))
        for f in result["findings"]:
            causes = [o["event_id"]] + [state["signal_event_ids"][sid] for sid in f["signal_ids"] if sid in state["signal_event_ids"]]
            event_id = state["blackbox"].record(
                "challenge_issued",
                {"from": "forensics", "against": role, "claim": f["claim"], "severity": f["severity"], "targets": o["event_id"]},
                causes,
            )
            challenges.append({**f, "from": "forensics", "against": role, "targets": o["event_id"], "event_id": event_id, "mechanical": True, "cites": f["signal_ids"]})
    _emit(state, "audit", f"{len(challenges)} mechanical finding(s)")
    return {"challenges": challenges}


async def _issue_challenge(challenger: AgentSpec, target_role: str, state: CouncilState) -> dict | None:
    target = state["openings"][target_role]
    mechanical = [c for c in state["challenges"] if c.get("mechanical") and c["against"] == target_role]

    if challenger.role == "adversarial":
        shared = (
            "BOTH OPENING POSITIONS (you may attack a flaw they share)\n"
            + "\n\n".join(render_belief(r, o["belief"]) for r, o in state["openings"].items() if r in ("bull", "bear"))
            + f"\n\nFile THIS challenge against the {target_role.upper()}. If the flaw is\n"
            "one both sides made, say so plainly in the claim — it is being filed\n"
            "separately against each of them and the Judge will see both."
        )
    else:
        shared = (
            f"TARGET BELIEF\n{render_belief(target_role, target['belief'])}\n\n"
            f"MECHANICAL AUDIT OF THIS BELIEF'S CITATIONS (already run — these are facts)\n{render_findings(mechanical)}"
        )

    prompt = (
        f"{state['market_text']}\n\nEVIDENCE\n{state['evidence_text']}\n\n{shared}\n\n"
        f"Issue at most ONE challenge against the {target_role.upper()}'s reasoning.\n"
        'If the reasoning holds up, return severity "none" with an empty claim.'
    )
    out = await with_deadline(
        llm.ask(Challenge, f"{HOUSE_RULES}\n\n{challenger.persona}", prompt),
        state["budget"].left() - RESERVE_RESPOND - RESERVE_JUDGE,
        f"{challenger.role} vs {target_role}",
    )
    return {
        "from": challenger.role,
        "against": target_role,
        "severity": out.severity,
        "claim": out.claim,
        "cites": out.cites,
        "targets": target["event_id"],
        "mechanical": False,
    }


async def node_challenge(state: CouncilState) -> dict:
    targets = [r for r in ("bull", "bear") if r in state["openings"]]
    challengers = list(CHALLENGERS)
    skipped = list(state.get("skipped", []))

    def rounds_affordable(n: int) -> bool:
        return state["budget"].affords(n * RESERVE_CHALLENGE, RESERVE_RESPOND + RESERVE_JUDGE)

    if not rounds_affordable(2):
        if rounds_affordable(1):
            challengers = [FORENSICS]
            skipped.append(f"adversarial round dropped: {state['budget'].left():.0f}s left, not enough for both challengers")
        else:
            challengers = []
            skipped.append(f"entire challenge round dropped: {state['budget'].left():.0f}s left, reserved for responses and verdict")

    _emit(state, "challenge", f"{[c.role for c in challengers]} vs {targets}" if challengers else "skipped by the wall-clock governor")

    arms = [(_issue_challenge(c, t, state), c, t) for c in challengers for t in targets]

    async def guarded(coro, c: AgentSpec, t: str):
        try:
            return await coro
        except Exception as e:  # noqa: BLE001
            skipped.append(f"{c.role}'s challenge to {t} failed: {e}")
            return None

    results = await asyncio.gather(*(guarded(coro, c, t) for coro, c, t in arms))

    challenges = list(state.get("challenges", []))
    for c in results:
        if c is None:
            continue
        if c["severity"] == "none":
            challenges.append(c)
            continue
        mech_causes = [
            m["event_id"] for m in challenges if m.get("mechanical") and m["against"] == c["against"] and m.get("event_id")
        ][:4]
        event_id = state["blackbox"].record(
            "challenge_issued",
            {"from": c["from"], "against": c["against"], "claim": c["claim"], "severity": c["severity"], "targets": c["targets"]},
            [c["targets"], *mech_causes],
        )
        c["event_id"] = event_id
        challenges.append(c)

    return {"challenges": challenges, "skipped": skipped}


async def _answer(role: str, state: CouncilState) -> dict:
    opening = state["openings"][role]
    against = [c for c in state["challenges"] if c["against"] == role and c["severity"] != "none" and c.get("event_id")]

    prompt = (
        f"{state['market_text']}\n\nEVIDENCE\n{state['evidence_text']}\n\n"
        f"YOUR OPENING POSITION\n{render_belief(role, opening['belief'])}\n\n"
        f"CHALLENGES FILED AGAINST YOU\n{render_challenges(against)}\n\n"
        "Answer them. If a challenge is right, move — and say specifically what\n"
        "changed your mind and why it moves the number as far as it does. If a\n"
        "challenge is wrong, hold and say precisely where it fails.\n\n"
        "Moving is not a loss and holding is not a win. You are scored on where\n"
        "the number ends up relative to what actually settles, and on whether your\n"
        "revisions moved you toward it."
    )
    res = await with_deadline(
        llm.ask(Response, f"{HOUSE_RULES}\n\n{opening['spec'].persona}", prompt),
        state["budget"].left() - RESERVE_JUDGE,
        f"{role} response",
    )
    caused_by = [c["event_id"] for c in against]
    moved = abs(res.p - opening["belief"].p) >= 0.005
    body = {"agent": role, "p": res.p, "confidence": opening["belief"].confidence, "rationale": res.rationale, "cites": res.cites}

    if moved:
        event_id = state["blackbox"].record(
            "belief_revised", {"belief": body, "from": opening["belief"].p, "supersedes": opening["event_id"]}, caused_by
        )
    else:
        event_id = state["blackbox"].record(
            "belief_held", {"agent": role, "p": res.p, "because": res.rationale}, caused_by
        )

    return {"agent": role, "from": opening["belief"].p, "to": res.p, "moved": moved, "rationale": res.rationale, "event_id": event_id}


async def node_respond(state: CouncilState) -> dict:
    live = [c for c in state["challenges"] if c["severity"] != "none" and c.get("event_id")]
    responders = sorted({c["against"] for c in live} & set(state["openings"].keys()))
    _emit(state, "respond", f"{len(live)} live challenge(s) awaiting an answer")

    skipped = list(state.get("skipped", []))

    async def guarded(role: str):
        try:
            return await _answer(role, state)
        except Exception as e:  # noqa: BLE001
            skipped.append(f"{role} could not answer its challenges: {e}")
            return None

    results = await asyncio.gather(*(guarded(r) for r in responders))
    resolutions = {r["agent"]: r for r in results if r is not None}
    final_p = dict(state.get("final_p", {}))
    final_p.update({role: r["to"] for role, r in resolutions.items()})

    _emit(
        state,
        "respond",
        "  ".join(f"{r} {pct(res['from'])}→{pct(res['to'])}{' (revised)' if res['moved'] else ' (held)'}" for r, res in resolutions.items())
        or "no responses",
    )
    return {"resolutions": resolutions, "final_p": final_p, "skipped": skipped}


async def node_judge(state: CouncilState) -> dict:
    _emit(state, "judge", "synthesising the verdict")
    live = [c for c in state["challenges"] if c["severity"] != "none" and c.get("event_id")]
    none_found = [c for c in state["challenges"] if c["severity"] == "none"]

    positions = []
    for role, o in state["openings"].items():
        res = state.get("resolutions", {}).get(role)
        head = render_belief(role, o["belief"])
        if res:
            positions.append(f"{head}\n  AFTER CHALLENGE: {pct(res['from'])} → {pct(res['to'])} ({'REVISED' if res['moved'] else 'HELD'})\n  \"{res['rationale']}\"")
        else:
            positions.append(f"{head}\n  (unchallenged)")

    prompt = "\n".join(
        [
            state["market_text"],
            "",
            "EVIDENCE",
            state["evidence_text"],
            "",
            "FINAL POSITIONS",
            "\n\n".join(positions),
            "",
            "CHALLENGES RAISED",
            render_challenges([c for c in state["challenges"] if c["severity"] != "none"]),
            "",
            "CHALLENGERS WHO FOUND NOTHING",
            "\n".join(f"  {c['from']} examined {c['against']} and raised no objection." for c in none_found) or "  (none)",
            "",
            "RUN NOTES",
            "\n".join(f"  - {s}" for s in state.get("skipped", [])) or "  the council ran in full; nothing was skipped",
            "",
            "Deliver the council's probability that YES settles true.",
        ]
    )

    try:
        verdict = await with_deadline(
            llm.ask(Verdict, f"{HOUSE_RULES}\n\n{JUDGE.persona}", prompt), state["budget"].left(), "judge"
        )
    except Exception as e:  # noqa: BLE001
        _record_skip(state, "skipped_verdict", f"judge failed: {e}")
        return {"verdict": None, "verdict_event_id": None}

    causes = [
        (state.get("resolutions", {}).get(role) or o).get("event_id", o["event_id"])
        for role, o in state["openings"].items()
    ] + [c["event_id"] for c in live]
    verdict_event_id = state["blackbox"].record(
        "verdict", {"p": verdict.p, "dissent": verdict.dissent, "spread": _spread(state.get("final_p", {}))}, causes
    )
    _emit(state, "judge", f"verdict {pct(verdict.p)}")
    return {"verdict": verdict, "verdict_event_id": verdict_event_id}


def _spread(final_p: dict[str, float]) -> float:
    d = [final_p.get("bull"), final_p.get("bear")]
    if None in d:
        return 0.0
    return round(abs(d[0] - d[1]), 4)  # type: ignore[arg-type]


async def node_edge(state: CouncilState) -> dict:
    verdict = state.get("verdict")
    market_implied = state.get("market_implied")
    if verdict is None:
        return {"edge": None}
    if market_implied is None:
        _record_skip(state, "skipped_edge", "no market-implied probability: the book is empty or one-sided")
        return {"edge": None}
    edge = round(verdict.p - market_implied, 4)
    state["blackbox"].record(
        "edge_computed",
        {"marketImplied": market_implied, "councilP": verdict.p, "edge": edge},
        [state["verdict_event_id"]] if state.get("verdict_event_id") else [],
    )
    _emit(state, "done", f"edge {edge:+.4f}")
    return {"edge": edge}


def build_graph(venue: Venue):
    # `async def` closures, not lambdas: LangGraph decides whether to await a
    # node via `inspect.iscoroutinefunction`. A lambda that merely returns a
    # coroutine (by calling an `async def` inside it) fails that check — the
    # lambda itself is a plain sync function — so LangGraph writes the raw
    # coroutine OBJECT into state instead of awaiting it, and every downstream
    # node blows up on "Expected dict, got coroutine object".
    async def _open(state: CouncilState) -> dict:
        return await node_open(state, venue)

    async def _audit(state: CouncilState) -> dict:
        return await node_audit(state, venue)

    g = StateGraph(CouncilState)
    g.add_node("observe", node_observe)
    g.add_node("open", _open)
    g.add_node("audit", _audit)
    g.add_node("challenge", node_challenge)
    g.add_node("respond", node_respond)
    g.add_node("judge", node_judge)
    g.add_node("edge", node_edge)

    g.set_entry_point("observe")
    g.add_edge("observe", "open")
    g.add_edge("open", "audit")
    g.add_edge("audit", "challenge")
    g.add_edge("challenge", "respond")
    g.add_edge("respond", "judge")
    g.add_edge("judge", "edge")
    g.add_edge("edge", END)
    return g.compile()


async def convene(
    venue: Venue,
    market_id: str,
    market_text: str,
    evidence_text: str,
    signals: list[dict],
    market_implied: float | None,
    session_id: str,
    budget_s: float = DEFAULT_BUDGET_S,
    on_progress: Callable[[dict], None] | None = None,
    on_event: Callable[[Any], None] | None = None,
    blackbox: BlackBox | None = None,
) -> CouncilState:
    """Run one full council session. Returns the final graph state, which
    includes the BlackBox — the caller persists it (see cli.py / main.py).

    Pass `blackbox` when a caller (the FastAPI session registry) already owns
    the instance a client is subscribed to — a session must write to the SAME
    object that streaming reads from, not a private copy convene() made for
    itself.
    """
    bb = blackbox if blackbox is not None else BlackBox(session_id, market_id)
    if on_event:
        bb.record = _instrument_record(bb, on_event)  # type: ignore[method-assign]

    graph = build_graph(venue)
    initial: CouncilState = {
        "market_id": market_id,
        "market_text": market_text,
        "evidence_text": evidence_text,
        "signals": signals,
        "market_implied": market_implied,
        "budget": Budget(budget_s),
        "blackbox": bb,
        "on_progress": on_progress,
        "on_event": on_event,
        "skipped": [],
    }
    return await graph.ainvoke(initial, config={"recursion_limit": 30})


def _instrument_record(bb: BlackBox, on_event: Callable[[Any], None]):
    """Wrap BlackBox.record so a subscriber sees each event as it lands —
    Python's BlackBox has no subscribe(), so this is the equivalent hook."""
    original = bb.record

    def wrapped(kind: str, data: dict | None = None, caused_by: list[str] | None = None) -> str:
        event_id = original(kind, data, caused_by)
        on_event(bb.get(event_id))
        return event_id

    return wrapped
