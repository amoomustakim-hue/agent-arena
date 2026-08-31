"""Agent Arena backend.

FastAPI owns orchestration and the HTTP/WebSocket surface. It reaches the
DreamDEX venue only through MCP (see venue.py), which keeps the chain-specific
code in one TypeScript package and makes the read-only/privileged split a
process boundary rather than a convention.
"""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import sessions
from .agents.config import llm_status
from .agents.council import convene
from .config import settings
from .settle import score_session
from .trading import TradingUnavailable, trading
from .venue import VenueUnavailable, venue

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(name)s  %(message)s")
log = logging.getLogger("arena")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Hold one MCP session for the process lifetime.

    Connecting lazily on first request would make the first user pay a Node
    startup, and a failure would surface as a confusing 500 rather than a
    refusal to boot. If the venue is unreachable the API still starts — /health
    reports it — because a dead venue should not stop the UI from loading and
    explaining itself.
    """
    try:
        await venue.connect()
    except VenueUnavailable as exc:
        log.error("venue unavailable at startup: %s", exc)
    try:
        await trading.connect()
    except TradingUnavailable as exc:
        log.error("trading MCP unavailable at startup: %s", exc)
    yield
    await venue.close()
    await trading.close()


app = FastAPI(
    title="Agent Arena",
    version="0.1.0",
    summary="Agent-native prediction-market intelligence over DreamDEX Event Contracts.",
    lifespan=lifespan,
)

# The frontend is served from a different origin in development. apps/web
# runs on 3100 (see its package.json), not Next's default 3000 — a plain
# copy-paste of the usual default here would have silently blocked every
# request from the actual frontend with no server-side error to point at.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3100", "http://127.0.0.1:3100"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    """Whether the backend can actually reach the venue.

    Reports `degraded` rather than failing: the distinction between "the API is
    down" and "the API is up but the venue is not" is the first thing anyone
    debugging this needs, and a 500 collapses the two.
    """
    llm = llm_status()
    return {
        "status": "ok" if venue.connected and trading.connected and llm["ready"] else "degraded",
        "venue": "connected" if venue.connected else "unavailable",
        "trading": "connected" if trading.connected else "unavailable",
        "mode": "fixtures" if settings.fixtures else "live",
        "network": settings.network,
        "model": settings.model,
        "mcpTools": venue.tools,
        "tradingMcpTools": trading.tools,
        "llm": llm,
    }


@app.get("/markets")
async def list_markets(
    asset: str | None = Query(None, description="Filter to BTC or ETH"),
    max: int = Query(10, ge=1, le=50),
) -> dict:
    try:
        return await venue.discover(asset=asset, max_markets=max)
    except VenueUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/markets/{market_id}")
async def get_market(market_id: str) -> dict:
    try:
        return await venue.market(market_id)
    except VenueUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/markets/{market_id}/evidence")
async def get_evidence(market_id: str) -> dict:
    """The evidence table, split independent vs circular.

    The split is the product's intellectual core: circular signals are the
    contract's own price, which already IS the market's probability estimate,
    so they cannot justify disagreeing with the market.
    """
    try:
        return await venue.evidence(market_id)
    except VenueUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/markets/{market_id}/orderbook")
async def get_orderbook(market_id: str, depth: int = Query(5, ge=1, le=20)) -> dict:
    try:
        return await venue.orderbook(market_id, depth=depth)
    except VenueUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/markets/{market_id}/implied")
async def get_implied(market_id: str) -> dict:
    try:
        return await venue.implied(market_id)
    except VenueUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


class ConveneRequest(BaseModel):
    budgetS: float = 300.0


@app.post("/council/{market_id}")
async def start_council(market_id: str, body: ConveneRequest = ConveneRequest()) -> dict:
    """Start a council session in the background and return its id immediately.

    The run continues even if no client ever opens the WebSocket — a council
    that stops because the browser tab closed would make the trade proposal
    that depends on it disappear along with the tab. Subscribe with
    GET /ws/council/{sessionId}; late subscribers are replayed from seq 0.
    """
    status = llm_status()
    if not status["ready"]:
        raise HTTPException(status_code=503, detail=status["detail"])

    try:
        m = await venue.market(market_id)
        e = await venue.evidence(market_id)
    except VenueUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    session_id = f"council-{int(time.time() * 1000)}"
    session = sessions.create(session_id, market_id)

    async def on_event(ev) -> None:
        await sessions.broadcast_event(session, ev)

    async def on_progress(p: dict) -> None:
        await sessions.broadcast_progress(session, p)

    async def run() -> None:
        try:
            outcome = await convene(
                venue,
                market_id=market_id,
                market_text=m["text"],
                evidence_text=e["text"],
                signals=e["signals"],
                market_implied=m.get("yesMid"),
                market_meta={"strike": m.get("strike", 0), "expiry": m.get("expiry"), "intervalSec": m.get("intervalSec"), "status": m.get("status")},
                session_id=session_id,
                budget_s=body.budgetS,
                # convene() calls these synchronously; bridge to the async
                # broadcast without blocking a graph node on network I/O to
                # every connected socket.
                on_progress=lambda p: asyncio.create_task(on_progress(p)),
                on_event=lambda ev: asyncio.create_task(on_event(ev)),
                blackbox=session.blackbox,
            )
            session.outcome = {
                "verdict": outcome["verdict"].model_dump() if outcome.get("verdict") else None,
                "edge": outcome.get("edge"),
                "skipped": outcome.get("skipped", []),
            }
            session.status = "done"
            session.blackbox.save(settings.sessions_dir)
        except Exception as exc:  # noqa: BLE001
            log.exception("council session %s failed", session_id)
            session.status = "error"
            session.error = str(exc)
        await sessions.broadcast_progress(session, {"phase": "closed", "detail": session.status})

    session.task = asyncio.create_task(run())
    return {"sessionId": session_id, "marketId": market_id}


@app.websocket("/ws/council/{session_id}")
async def council_stream(websocket: WebSocket, session_id: str) -> None:
    """Live feed of one council session.

    Replays every event recorded so far on connect, THEN streams new ones —
    so a client that attaches mid-run sees the full causal graph rather than
    only what happens to occur after it opened the socket.
    """
    session = sessions.get(session_id)
    if session is None:
        await websocket.close(code=4404, reason="unknown session")
        return

    await websocket.accept()
    for ev in session.blackbox.all():
        await websocket.send_json({"type": "event", "event": ev.to_json()})
    await websocket.send_json({"type": "status", "status": session.status})

    session.listeners.append(websocket)
    try:
        while True:
            # This endpoint is push-only; block on receive so a disconnect
            # (which raises) is the only reason this loop ever exits.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in session.listeners:
            session.listeners.remove(websocket)


@app.get("/council/{session_id}")
async def get_council(session_id: str) -> dict:
    """Poll fallback for clients without WebSocket support, and the terminal
    read for a session that already finished."""
    session = sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"No session {session_id}")
    return {
        "sessionId": session.session_id,
        "marketId": session.market_id,
        "status": session.status,
        "error": session.error,
        "outcome": session.outcome,
        "events": [e.to_json() for e in session.blackbox.all()],
    }


@app.post("/council/{session_id}/propose")
async def propose_trade(session_id: str, body: dict | None = None) -> dict:
    """Turn a FINISHED council's verdict into a priced, risk-checked proposal.

    Read-only end to end — see trading.py and arena-trade-mcp's own README for
    why. This records `trade_proposed` and `risk_verdict` into the SESSION's
    own Black Box (not a bare pass-through), so the proposal joins the same
    causal graph the belief history lives in: it cites the verdict, and
    anything built on top of it later can trace back through the debate that
    produced the number it is priced against.

    There is deliberately no sibling endpoint that can approve or execute
    this proposal.
    """
    session = sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"No session {session_id}")
    if session.status != "done" or not session.outcome or not session.outcome.get("verdict"):
        raise HTTPException(status_code=409, detail="Council has not reached a verdict yet.")

    verdict = session.outcome["verdict"]
    budget = (body or {}).get("budgetCollateral")
    try:
        result = await trading.propose(session.market_id, verdict["p"], budget=budget)
    except TradingUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    verdict_event = next((e for e in session.blackbox.all() if e.kind == "verdict"), None)
    caused_by = [verdict_event.id] if verdict_event else []

    proposed_id = None
    if result["proposal"]:
        proposed_id = session.blackbox.record("trade_proposed", result["proposal"], caused_by)
        await sessions.broadcast_event(session, session.blackbox.get(proposed_id))
    if result["risk"]:
        risk_caused_by = [proposed_id] if proposed_id else caused_by
        risk_id = session.blackbox.record("risk_verdict", result["risk"], risk_caused_by)
        await sessions.broadcast_event(session, session.blackbox.get(risk_id))

    return {"sessionId": session_id, **result}


@app.get("/markets/{market_id}/settlement")
async def get_settlement(market_id: str) -> dict:
    """Whether a contract has settled on-chain. Read-only — no claim action."""
    try:
        return await trading.check_settlement(market_id)
    except TradingUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/council/{session_id}/settle")
async def settle_session(session_id: str) -> dict:
    """Manual settle trigger: check the chain, then score the council.

    A manual trigger rather than a background watcher on purpose — for a
    demo, a button you press on stage is more controllable than a poller you
    have to trust fired at the right moment, and a 15-minute contract means
    you are never waiting long anyway. Refuses to score anything if the
    session hasn't reached a verdict, or if the market hasn't actually
    settled on-chain yet — an unsettled forecast is not a result, and
    scoring it would inflate every number downstream of it.
    """
    session = sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"No session {session_id}")
    if any(e.kind == "settled" for e in session.blackbox.all()):
        raise HTTPException(status_code=409, detail="Already settled.")

    try:
        result = await trading.check_settlement(session.market_id)
    except TradingUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    outcome = result["outcome"]
    if outcome is None:
        return {"sessionId": session_id, "settled": False, "detail": result["text"]}

    verdict_event = next((e for e in session.blackbox.all() if e.kind == "verdict"), None)
    settled_id = session.blackbox.record("settled", {"outcome": outcome}, [verdict_event.id] if verdict_event else [])
    await sessions.broadcast_event(session, session.blackbox.get(settled_id))

    scores = score_session(session.blackbox, outcome, [settled_id])
    for row in scores:
        scored_event = next(
            (e for e in reversed(session.blackbox.all()) if e.kind == "scored" and e.data["agent"] == row["agent"]),
            None,
        )
        if scored_event:
            await sessions.broadcast_event(session, scored_event)

    return {"sessionId": session_id, "settled": True, "outcome": outcome, "scores": scores}


@app.post("/markets/{market_id}/audit")
async def post_audit(market_id: str, body: dict) -> dict:
    """Check an argument's citations for fabrication and circular reasoning.

    Exposed over HTTP so the UI can audit a human's reasoning on the same terms
    as an agent's — the check is a property of the argument, not of who made it.
    """
    cites = body.get("cites")
    if not isinstance(cites, list) or not all(isinstance(c, str) for c in cites):
        raise HTTPException(status_code=422, detail="`cites` must be a list of signal id strings.")
    try:
        return await venue.audit(market_id, cites, bool(body.get("directional", True)))
    except VenueUnavailable as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
