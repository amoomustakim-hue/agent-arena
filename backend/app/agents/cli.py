"""Run one council session end to end against the live venue (or --fixtures).

    python -m app.agents.cli
    python -m app.agents.cli --market 0x...
    python -m app.agents.cli --fixtures
"""

from __future__ import annotations

import argparse
import asyncio
import time

from ..config import settings
from ..venue import venue
from .council import convene, pct


def _pick_market(markets: list[dict]) -> dict | None:
    """Most headroom by RATIO (secondsLeft / intervalSec), not absolute
    seconds — a 24h contract with 30 minutes left has more raw time than a 15m
    contract that just opened, but far less room relative to its own window."""
    candidates = [m for m in markets if m["hasHeadroom"]]
    return candidates[0] if candidates else None


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", help="marketId; default picks the live market with most headroom")
    ap.add_argument("--asset")
    ap.add_argument("--budget", type=float, default=300.0)
    args = ap.parse_args()

    print(f"model     {settings.model}")
    print(f"mode      {'fixtures' if settings.fixtures else 'live'}")
    print(f"network   {settings.network}\n")

    await venue.connect()
    try:
        discovered = await venue.discover(asset=args.asset, max_markets=20)
        market = None
        if args.market:
            market = next((m for m in discovered["markets"] if m["marketId"] == args.market), None)
        else:
            market = _pick_market(discovered["markets"])

        if not market:
            print("No market with enough headroom to convene on.")
            return

        mid = market["marketId"]
        print(f"convening on {mid}  ({market['asset']} {market['window']}) — \"{market['question']}\"\n")

        m = await venue.market(mid)
        e = await venue.evidence(mid)
        print(m["text"])
        print()
        print(e["text"])
        print()

        def on_progress(p: dict) -> None:
            print(f"[{p['sLeft']:6.0f}s left] {p['phase']:<10} {p['detail']}")

        session_id = f"py-council-{int(time.time())}"
        outcome = await convene(
            venue,
            market_id=mid,
            market_text=m["text"],
            evidence_text=e["text"],
            signals=e["signals"],
            market_implied=m.get("yesMid"),
            market_meta={"strike": m.get("strike", 0), "expiry": m.get("expiry"), "intervalSec": m.get("intervalSec"), "status": m.get("status")},
            session_id=session_id,
            budget_s=args.budget,
            on_progress=on_progress,
        )

        print("\n" + "=" * 70)
        for role, o in outcome.get("openings", {}).items():
            b = o["belief"]
            print(f"{role.upper():<12} opened {pct(b.p)}  cites={b.cites}")

        for c in outcome.get("challenges", []):
            if c["severity"] == "none":
                continue
            print(f"\nCHALLENGE  {c['from']} -> {c['against']}  [{c['severity'].upper()}]\n  {c['claim']}")

        for role, r in outcome.get("resolutions", {}).items():
            arrow = "REVISED" if r["moved"] else "HELD"
            print(f"\n{role.upper()} {arrow}  {pct(r['from'])} -> {pct(r['to'])}\n  {r['rationale']}")

        verdict = outcome.get("verdict")
        if verdict:
            print(f"\nVERDICT  P(YES) = {pct(verdict.p)}")
            print(f"  dissent: {verdict.dissent}")
        edge = outcome.get("edge")
        if edge is not None:
            print(f"  edge: {edge:+.4f}")

        if outcome.get("skipped"):
            print("\nRUN NOTES")
            for s in outcome["skipped"]:
                print(f"  - {s}")

        path = outcome["blackbox"].save(settings.sessions_dir)
        print(f"\nsaved -> {path}")
    finally:
        await venue.close()


if __name__ == "__main__":
    asyncio.run(main())
