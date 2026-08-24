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
from .agents.config import anthropic_status
from .agents.council import convene
from .config import settings
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
    yield
    await venue.close()


app = FastAPI(
    title="Agent Arena",
    version="0.1.0",
    summary="Agent-native prediction-market intelligence over DreamDEX Event Contracts.",
    lifespan=lifespan,
)

# The frontend is served from a different origin in development.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
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
    anthropic = anthropic_status()
    return {
        "status": "ok" if venue.connected and anthropic["ready"] else "degraded",
        "venue": "connected" if venue.connected else "unavailable",
        "mode": "fixtures" if settings.fixtures else "live",
        "network": settings.network,
        "model": settings.model,
        "mcpTools": venue.tools,
        "anthropic": anthropic,
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
    status = anthropic_status()
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
