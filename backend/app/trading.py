"""The privileged MCP client — and why it stays half-privileged from here too.

Mirrors `venue.py`'s shape exactly: a long-lived MCP session over stdio, one
call at a time behind a lock. The difference is which server it talks to.

`packages/arena-trade-mcp` already refuses to expose anything that can send a
real order — see that package's own README. This module inherits that
refusal rather than working around it: there is no `execute` method here,
and there will not be one until this backend can prove a specific HTTP
request was a human clicking an Approve button (real auth, real session,
real audit log) rather than an LLM deciding to call an endpoint. An HTTP
route *can* carry that proof in a way an MCP tool call cannot — but building
that proof properly is a deliberate, later decision, not a byproduct of
wiring up the read-only half.
"""

from __future__ import annotations

import asyncio
import logging
import re
from contextlib import AsyncExitStack
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from .config import settings

log = logging.getLogger("arena.trading")


class TradingUnavailable(RuntimeError):
    """The trading MCP server could not be reached or answered with an error."""


class Trading:
    def __init__(self) -> None:
        self._session: ClientSession | None = None
        self._stack: AsyncExitStack | None = None
        self._lock = asyncio.Lock()
        self._tools: list[str] = []

    async def connect(self) -> None:
        if self._session is not None:
            return
        command, args = settings.trading_mcp_command()
        log.info("spawning trading MCP server: %s %s", command, " ".join(args))

        stack = AsyncExitStack()
        try:
            read, write = await stack.enter_async_context(
                stdio_client(
                    StdioServerParameters(
                        command=command,
                        args=args,
                        env=settings.mcp_env(),
                        cwd=str(settings.repo_root),
                    )
                )
            )
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
        except Exception as exc:  # noqa: BLE001
            await stack.aclose()
            raise TradingUnavailable(f"Could not start the trading MCP server: {exc}") from exc

        listing = await session.list_tools()
        self._tools = [t.name for t in listing.tools]
        # Belt and braces: refuse to proceed if this server ever grows a
        # mutating tool without this file being updated to match. A silent
        # capability increase here is exactly the failure mode the whole
        # "no execute tool" design is meant to prevent.
        mutating = [
            t.name
            for t in listing.tools
            if not (t.annotations and getattr(t.annotations, "readOnlyHint", False))
        ]
        if mutating:
            await stack.aclose()
            raise TradingUnavailable(
                f"Trading MCP server exposes non-read-only tool(s) {mutating} — "
                f"this client does not know how to gate that and refuses to connect."
            )
        self._session = session
        self._stack = stack
        log.info("trading MCP connected — %d read-only tools: %s", len(self._tools), ", ".join(self._tools))

    async def close(self) -> None:
        if self._stack is not None:
            await self._stack.aclose()
        self._session = None
        self._stack = None

    @property
    def connected(self) -> bool:
        return self._session is not None

    @property
    def tools(self) -> list[str]:
        return list(self._tools)

    async def call(self, tool: str, **arguments: Any) -> str:
        if self._session is None:
            await self.connect()
        assert self._session is not None
        async with self._lock:
            result = await self._session.call_tool(tool, arguments)
        text = "\n".join(b.text for b in result.content if getattr(b, "type", None) == "text")
        if result.isError:
            raise TradingUnavailable(f"{tool} failed: {text or 'no detail'}")
        return text

    async def propose(
        self,
        market_id: str,
        council_p: float,
        budget: float | None = None,
        min_ev: float | None = None,
        order_type: str | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {"marketId": market_id, "councilP": council_p}
        if budget is not None:
            args["budget"] = budget
        if min_ev is not None:
            args["minEv"] = min_ev
        if order_type is not None:
            args["orderType"] = order_type
        text = await self.call("propose_trade", **args)
        return {"text": text, "proposal": _parse_proposal(text), "risk": _parse_risk(text)}

    async def check_settlement(self, market_id: str) -> dict[str, Any]:
        text = await self.call("check_settlement", marketId=market_id)
        outcome = None
        if " settled YES" in text:
            outcome = "YES"
        elif " settled NO" in text:
            outcome = "NO"
        elif "VOIDED" in text:
            outcome = "VOID"
        return {"text": text, "outcome": outcome}


# --- parsing helpers ---------------------------------------------------------
#
# Same philosophy as venue.py: the text stays authoritative, these just lift
# out the fields the API layer actually needs to record structured Black Box
# events. Anything these miss is still visible in `text`.


def _parse_proposal(text: str) -> dict[str, Any] | None:
    m = re.search(r"^PROPOSAL — buy (YES|NO)", text, re.M)
    if not m:
        return None
    return {
        "side": m.group(1),
        "size": _f(text, r"size:\s+([\d.]+) shares"),
        "limitPrice": _pct(text, r"limit price:\s+([\d.]+)%"),
        "maxLoss": _f(text, r"max loss:\s+([\d.]+) collateral"),
        "councilP": _pct(text, r"council:\s+([\d.]+)%"),
        "marketP": _pct(text, r"vs market ([\d.]+)%"),
        "breakeven": _pct(text, r"breakeven:\s+([\d.]+)%"),
        "evPerShare": _f(text, r"edge:\s+([\-\d.]+)pp/share"),
        "invalidation": _s(text, r"Invalidation:\s*(.+?)\s*$", re.M),
    }


def _parse_risk(text: str) -> dict[str, Any] | None:
    m = re.search(r"^RISK — (PASS|BLOCKED)", text, re.M)
    if not m:
        return None
    concerns = re.findall(r"^\s*\d+\.\s+(.+)$", text.split("Warnings")[0].split("Blocking concerns:")[-1], re.M) if "Blocking concerns:" in text else []
    warnings = re.findall(r"^\s*\d+\.\s+(.+)$", text.split("Warnings (non-blocking):")[-1], re.M) if "Warnings (non-blocking):" in text else []
    return {"ok": m.group(1) == "PASS", "concerns": concerns, "warnings": warnings}


def _s(text: str, pattern: str, flags: int = 0) -> str | None:
    m = re.search(pattern, text, flags)
    return m.group(1) if m else None


def _f(text: str, pattern: str) -> float | None:
    raw = _s(text, pattern)
    try:
        return float(raw) if raw is not None else None
    except ValueError:
        return None


def _pct(text: str, pattern: str) -> float | None:
    v = _f(text, pattern)
    return v / 100 if v is not None else None


trading = Trading()
