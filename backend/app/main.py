"""Agent Arena backend.

FastAPI owns orchestration and the HTTP/WebSocket surface. It reaches the
DreamDEX venue only through MCP (see venue.py), which keeps the chain-specific
code in one TypeScript package and makes the read-only/privileged split a
process boundary rather than a convention.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

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
    return {
        "status": "ok" if venue.connected else "degraded",
        "venue": "connected" if venue.connected else "unavailable",
        "mode": "fixtures" if settings.fixtures else "live",
        "network": settings.network,
        "model": settings.model,
        "mcpTools": venue.tools,
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
