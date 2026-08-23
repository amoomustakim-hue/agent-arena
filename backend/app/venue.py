"""The MCP client — the backend's only route to DreamDEX.

This is the architectural seam. The backend never imports a DreamDEX SDK, never
touches viem, and never learns what a tick grid is. It asks an MCP server
questions and reads text answers, exactly as any other MCP client would.

Two things follow from that, and both are the point:

  - The safety split is enforced by process boundary, not by discipline. This
    client connects to the READ-ONLY intelligence server. It cannot place an
    order because the server it is talking to has no verb for it.

  - The venue's sharp edges — the 18-decimal float trap, lot snapping, pool
    recycling, the settlement-reference sentinel — stay solved once, in the
    TypeScript that has to deal with them, instead of being re-derived here in
    a second language.

The connection is held open for the process lifetime. MCP is a session
protocol, not request/response over HTTP: re-spawning the server per call would
pay a Node startup on every question and throw away the server's market cache.
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

log = logging.getLogger("arena.venue")


class VenueUnavailable(RuntimeError):
    """The MCP server could not be reached or answered with an error."""


class Venue:
    """A long-lived MCP client session against the intelligence server."""

    def __init__(self) -> None:
        self._session: ClientSession | None = None
        self._stack: AsyncExitStack | None = None
        self._lock = asyncio.Lock()
        self._tools: list[str] = []

    # -- lifecycle ---------------------------------------------------------

    async def connect(self) -> None:
        """Spawn the MCP server and complete the handshake."""
        if self._session is not None:
            return
        command, args = settings.mcp_command()
        log.info("spawning MCP server: %s %s", command, " ".join(args))

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
        except Exception as exc:  # noqa: BLE001 - reported, not swallowed
            await stack.aclose()
            raise VenueUnavailable(
                f"Could not start the MCP intelligence server: {exc}. "
                f"Check that `pnpm install` has run and that {settings.tsx_cli} exists."
            ) from exc

        listing = await session.list_tools()
        self._tools = [t.name for t in listing.tools]
        self._session = session
        self._stack = stack
        log.info("MCP connected — %d tools: %s", len(self._tools), ", ".join(self._tools))

    async def close(self) -> None:
        if self._stack is not None:
            await self._stack.aclose()
        self._session = None
        self._stack = None

    @property
    def tools(self) -> list[str]:
        return list(self._tools)

    @property
    def connected(self) -> bool:
        return self._session is not None

    # -- calling -----------------------------------------------------------

    async def call(self, tool: str, **arguments: Any) -> str:
        """Call one MCP tool and return its text content.

        Serialised behind a lock: one stdio pipe, one conversation at a time.
        Concurrent writes to the same transport interleave frames and corrupt
        the stream, which surfaces much later as an unrelated parse error.
        """
        if self._session is None:
            await self.connect()
        assert self._session is not None

        async with self._lock:
            result = await self._session.call_tool(tool, arguments)

        text = "\n".join(
            block.text for block in result.content if getattr(block, "type", None) == "text"
        )
        if result.isError:
            raise VenueUnavailable(f"{tool} failed: {text or 'no detail'}")
        return text

    # -- typed-ish helpers -------------------------------------------------
    #
    # The MCP tools return prose for models to read. The API layer needs a
    # little structure, so these parse the few fields the UI actually binds to
    # and pass the full text through untouched. The text stays authoritative:
    # anything these parsers miss is still visible to the caller, rather than
    # silently dropped on the way to becoming a dataclass.

    async def discover(self, asset: str | None = None, max_markets: int = 10) -> dict[str, Any]:
        args: dict[str, Any] = {"max": max_markets}
        if asset:
            args["asset"] = asset
        text = await self.call("discover_markets", **args)
        return {"text": text, "markets": _parse_markets(text)}

    async def market(self, market_id: str) -> dict[str, Any]:
        text = await self.call("get_market", marketId=market_id)
        return {
            "marketId": market_id,
            "text": text,
            "reference": _find_float(text, r"^\s*([\d.]+)\s+—\s+the", flags=re.M),
            "status": _find_int(text, r"On-chain status:\s*(\d+)"),
            "yesMid": _find_pct(text, r"mid\s+([\d.]+)%"),
            "timeLeft": _find_str(text, r"Time left:\s*(\S+)"),
        }

    async def evidence(self, market_id: str) -> dict[str, Any]:
        text = await self.call("get_evidence", marketId=market_id)
        return {
            "marketId": market_id,
            "text": text,
            "independent": _find_int(text, r"INDEPENDENT EVIDENCE \((\d+)\)") or 0,
            "circular": _find_int(text, r"CIRCULAR EVIDENCE \((\d+)\)") or 0,
            "signals": _parse_signals(text),
        }

    async def implied(self, market_id: str) -> dict[str, Any]:
        text = await self.call("implied_probability", marketId=market_id)
        return {"marketId": market_id, "text": text, "pYes": _find_pct(text, r"P\(YES\)\s*=\s*([\d.]+)%")}

    async def orderbook(self, market_id: str, depth: int = 5) -> dict[str, Any]:
        text = await self.call("get_orderbook", marketId=market_id, depth=depth)
        return {
            "marketId": market_id,
            "text": text,
            "bid": _find_pct(text, r"bid\s+([\d.]+)%"),
            "ask": _find_pct(text, r"ask\s+([\d.]+)%"),
            "mid": _find_pct(text, r"mid\s+([\d.]+)%"),
        }

    async def audit(self, market_id: str, cites: list[str], directional: bool = True) -> dict[str, Any]:
        text = await self.call(
            "audit_citations", marketId=market_id, cites=cites, directional=directional
        )
        return {
            "marketId": market_id,
            "text": text,
            "passed": text.lstrip().startswith("PASS"),
            "fatal": "[FATAL]" in text,
        }


# --- parsing helpers -------------------------------------------------------


def _find_str(text: str, pattern: str, flags: int = 0) -> str | None:
    m = re.search(pattern, text, flags)
    return m.group(1) if m else None


def _find_float(text: str, pattern: str, flags: int = 0) -> float | None:
    raw = _find_str(text, pattern, flags)
    try:
        return float(raw) if raw is not None else None
    except ValueError:
        return None


def _find_int(text: str, pattern: str, flags: int = 0) -> int | None:
    raw = _find_str(text, pattern, flags)
    try:
        return int(raw) if raw is not None else None
    except ValueError:
        return None


def _find_pct(text: str, pattern: str, flags: int = 0) -> float | None:
    """A percentage in the text becomes a probability in (0,1)."""
    v = _find_float(text, pattern, flags)
    return v / 100 if v is not None else None


_MARKET_RE = re.compile(
    r"^(0x\w+)\s*\n\s*(\w+)\s+·\s+(\S+)\s+window\s+·\s+\"([^\"]+)\"\s*\n\s*expires in (\S+)(.*)$",
    re.M,
)


def _parse_markets(text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in _MARKET_RE.finditer(text):
        market_id, asset, window, question, expires, tail = m.groups()
        out.append(
            {
                "marketId": market_id,
                "asset": asset,
                "window": window,
                "question": question,
                "expiresIn": expires,
                "hasHeadroom": "TOO LATE" not in tail,
            }
        )
    return out


_SIGNAL_RE = re.compile(r"^\s{2}(\w+)\s{2,}([^:]+):\s*(.+?)(?:\s+\[(\d+)s old\])?\s*$", re.M)


def _parse_signals(text: str) -> list[dict[str, Any]]:
    """Signals, tagged by which section of the evidence table they sit in.

    The independent/circular split is the whole point of this payload, so it is
    recovered from the section headers rather than guessed from the signal name.
    """
    signals: list[dict[str, Any]] = []
    circular_section = False
    for line in text.splitlines():
        if line.startswith("INDEPENDENT EVIDENCE"):
            circular_section = False
            continue
        if line.startswith("CIRCULAR EVIDENCE"):
            circular_section = True
            continue
        m = _SIGNAL_RE.match(line)
        if m and not line.strip().startswith("source:"):
            sid, label, value, stale = m.groups()
            signals.append(
                {
                    "id": sid,
                    "label": label.strip(),
                    "value": value.strip(),
                    "staleness": int(stale) if stale else 0,
                    "circular": circular_section,
                }
            )
    return signals


venue = Venue()
