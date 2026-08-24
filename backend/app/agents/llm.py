"""One structured call to Claude, plus the mechanical citation audit — which is
NOT reimplemented here. It is called over MCP against the already-tested
TypeScript `auditCitations` (see venue.audit). This is the same choice made
for market data: Python orchestrates, TypeScript owns venue-specific logic
exactly once.
"""

from __future__ import annotations

import asyncio
from typing import TypeVar

import anthropic
from pydantic import BaseModel

from ..config import settings
from ..venue import Venue

T = TypeVar("T", bound=BaseModel)

client = anthropic.AsyncAnthropic()


async def ask(schema: type[T], system: str, prompt: str, *, effort: str = "medium") -> T:
    """One structured-output call. Retries the SDK already handles (429, 5xx,
    connection errors) via max_retries; this only guards the shape of the
    response, since `parsed_output` can be None on a degenerate stop."""
    response = await client.messages.parse(
        model=settings.model,
        max_tokens=8000,
        system=system,
        thinking={"type": "adaptive"},
        output_config={"effort": effort},
        output_format=schema,
        messages=[{"role": "user", "content": prompt}],
    )
    if response.parsed_output is None:
        raise RuntimeError(f"{settings.model} returned no parseable output — stop_reason={response.stop_reason}")
    return response.parsed_output


async def audit(venue: Venue, market_id: str, cites: list[str], directional: bool = True) -> dict:
    """The mechanical check, run over MCP against the TypeScript implementation.

    Returns a dict shaped like the TS ForensicsFinding list this call is meant
    to stand in for: `{severity, claim, signal_ids}` per finding, parsed out of
    the tool's prose report. The prose IS the source of truth (a human or an
    LLM reading it gets the same information); this only recovers the fields
    the graph needs to record structured challenge_issued events.
    """
    result = await venue.audit(market_id, cites, directional)
    text = result["text"]
    if result["passed"]:
        return {"findings": []}

    findings = []
    for block in text.split("\n\n"):
        block = block.strip()
        if not block or not block[0].isdigit():
            continue
        # "1. [FATAL] claim text\n   signals: a, b"
        head, *rest = block.split("\n", 1)
        severity = "fatal" if "[FATAL]" in head else "material" if "[MATERIAL]" in head else "minor"
        claim = head.split("]", 1)[-1].strip()
        signal_ids: list[str] = []
        if rest and "signals:" in rest[0]:
            signal_ids = [s.strip() for s in rest[0].split("signals:", 1)[1].split(",") if s.strip()]
        findings.append({"severity": severity, "claim": claim, "signal_ids": signal_ids})
    return {"findings": findings}
