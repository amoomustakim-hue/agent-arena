"""One structured call to the configured LLM, plus the mechanical citation
audit — which is NOT reimplemented here. It is called over MCP against the
already-tested TypeScript `auditCitations` (see venue.audit). This is the
same choice made for market data: Python orchestrates, TypeScript owns
venue-specific logic exactly once.

Two providers behind one `ask()` — see `settings.llm_provider`:

  - anthropic (default): the real demo. `client.messages.parse()` with
    Claude's own structured-output support.
  - groq: free-tier testing. Groq hosts open-weight models (not Claude)
    behind an OpenAI-compatible API, which is why this reaches for the
    `openai` SDK rather than a Groq-specific one — pointed at Groq's
    base_url, that SDK IS a Groq client. Structured outputs there are
    strict-mode JSON schema, not a Pydantic-native `output_format`, so this
    module carries a small schema translator council.py and personas.py
    never need to know exists — every caller still just hands `ask()` a
    Pydantic model and gets one back.
"""

from __future__ import annotations

import os
from typing import Any, TypeVar

import anthropic
from pydantic import BaseModel

from ..config import settings
from ..venue import Venue

T = TypeVar("T", bound=BaseModel)

_anthropic_client: anthropic.AsyncAnthropic | None = None
_groq_client: Any | None = None


def _anthropic() -> anthropic.AsyncAnthropic:
    global _anthropic_client
    if _anthropic_client is None:
        _anthropic_client = anthropic.AsyncAnthropic()
    return _anthropic_client


def _groq():
    global _groq_client
    if _groq_client is None:
        # Imported here, not at module top, so a Claude-only deployment never
        # has to care whether `openai` is importable — it is (see
        # requirements.txt), but the dependency exists FOR Groq specifically.
        from openai import AsyncOpenAI

        # `api_key` must be passed explicitly: AsyncOpenAI's zero-arg
        # constructor falls back to OPENAI_API_KEY, not GROQ_API_KEY, and
        # would otherwise raise "missing credentials" even with a real Groq
        # key sitting right there in the environment.
        _groq_client = AsyncOpenAI(api_key=os.environ["GROQ_API_KEY"], base_url="https://api.groq.com/openai/v1")
    return _groq_client


def _strict_schema(schema: type[BaseModel]) -> dict:
    """Pydantic's `model_json_schema()` toward Groq/OpenAI strict mode.

    Strict mode requires, recursively, on every object: `additionalProperties:
    false` and EVERY property listed in `required` (no true-optional fields).
    Pydantic does not set the former and our schemas already satisfy the
    latter (see schemas.py — nothing here is `Optional`), so the only real
    work is walking `$defs` and inlining `additionalProperties: false`
    everywhere an object appears, including inside nested $refs.
    """
    raw = schema.model_json_schema()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object" and "properties" in node:
                node["additionalProperties"] = False
                node.setdefault("required", list(node["properties"].keys()))
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(raw)
    return raw


async def _ask_groq(schema: type[T], system: str, prompt: str) -> T:
    client = _groq()
    response = await client.chat.completions.create(
        model=settings.groq_model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        response_format={
            "type": "json_schema",
            "json_schema": {"name": schema.__name__, "strict": True, "schema": _strict_schema(schema)},
        },
    )
    content = response.choices[0].message.content
    if not content:
        raise RuntimeError(f"{settings.groq_model} (Groq) returned no content")
    return schema.model_validate_json(content)


async def _ask_anthropic(schema: type[T], system: str, prompt: str, effort: str) -> T:
    response = await _anthropic().messages.parse(
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


async def ask(schema: type[T], system: str, prompt: str, *, effort: str = "medium") -> T:
    """One structured-output call. On the Anthropic path, retries the SDK
    already handles (429, 5xx, connection errors) via max_retries; this only
    guards the shape of the response, since `parsed_output` can be None on a
    degenerate stop. `effort` is Claude-specific and silently ignored on the
    Groq path — Groq has no equivalent dial."""
    if settings.llm_provider == "groq":
        return await _ask_groq(schema, system, prompt)
    return await _ask_anthropic(schema, system, prompt, effort)


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
