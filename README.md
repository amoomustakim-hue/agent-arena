# Agent Arena

**The open intelligence layer for prediction markets** — AI traders debate in public, prove their track records, and turn their collective judgment into user-controlled trades on DreamDEX Event Contracts.

Built for the Somnia × dreamDEX Event Contracts Hackathon (18 Aug – 9 Sep 2026).

---

## What this is

Most prediction-market tooling asks one model for one number. Agent Arena runs an
adversarial council: specialists build opposing cases, a forensics agent audits
the evidence, an adversarial agent attacks both sides, and agents are expected to
change their minds when the attack lands. Every step is recorded to a **Prediction
Black Box** — an append-only, causally-linked flight recorder that can be replayed
after settlement to see exactly which piece of evidence moved which belief, or
counterfactually removed to see whether the verdict actually depended on it.

The whole thing sits on MCP: the analysis tools are a read-only server reusable by
any agent, and the trading tools are a separate, privileged server that a read-only
client cannot reach — and that, deliberately, cannot send a real order either. See
[Safety](#safety).

---

## Current status

Everything below is **verified live against the Shannon testnet**, not just built —
each package's own README/commit describes exactly how. The one thing not yet
verified is the council's actual LLM debate, which needs an `ANTHROPIC_API_KEY` this
environment doesn't have.

| Layer | Status |
|---|---|
| DreamDEX market adapter (live + offline fixtures) | ✅ Verified live |
| Prediction Black Box (TS + Python, interoperable JSONL) | ✅ Built, replay verified |
| Intelligence MCP server (read-only) | ✅ Verified live |
| Trading MCP server (privileged, zero fund-moving tools) | ✅ Verified live |
| FastAPI backend (council orchestration, both MCP clients) | ✅ Verified live |
| AI Trading Court (LangGraph, 6 personas) | ⏳ Built, typechecked — no LLM credentials to run it yet |
| War room UI (belief timeline, evidence split, debate feed, replay scrubber) | ✅ Built, rendered output verified against real fixture data |
| Counterfactual replay | ✅ Verified against three real scenarios in the fixture |
| Reputation UI (leaderboard, calibration, agent profiles) | ✅ Built, verified (falls back to a clearly-labelled synthetic corpus until a real session settles) |
| Agent lineage / forking engine | ✅ Built, tested — no UI yet |
| Trade execution | ❌ Not built. No signer anywhere in this codebase reaches an MCP tool — deliberately; see Safety |

---

## The one thing that makes the reasoning real

Event Contracts settle on BTC/ETH over fixed windows. That rules out the usual
prediction-market theatre — there is no news to cite on a 15-minute BTC contract,
and an agent quoting a headline would be performing analysis rather than doing it.

What the venue *does* offer is a sharp, checkable distinction. Every signal Agent
Arena captures is tagged by origin:

| Origin | Independent? | What it is |
|---|---|---|
| `underlying` | ✅ | Where BTC/ETH actually is, from the price feed |
| `chain` | ✅ | On-chain state, read directly |
| `clock` | ✅ | Time to expiry |
| `book` | ❌ **circular** | This contract's own orderbook |
| `derived` | ❌ **circular** | Anything computed from the book |

The book price **is** the market's probability estimate. Citing it as grounds to
disagree with the market is question-begging — and it is the mistake this venue
makes easiest, because restating the price always sounds like analysis. The kit's
own source warns about it:

> `fetchOrderBook` and `watchPrice`-on-a-symbol give you the event contract's OWN
> price (a probability), which is circular as a directional signal. Only the feed
> knows where BTC actually is.
> — `ec-core/config.ts`

So `auditCitations()` checks every belief mechanically, before any LLM sees it: an
agent that cites only circular signals for a directional claim is caught, every
time, deterministically. The Forensics agent then reasons about what the finding
*means*. Cheap checks first, expensive judgment second.

**This is why the debate is not theatre.** The challenges fire on genuine reasoning
failures specific to this venue, not on a script. The war room's counterfactual
view proves this structurally on a recorded session: removing the settlement
reference collapses the entire verdict; removing a decorative signal (the oracle
heartbeat) does nothing; removing a circular citation an agent later corrected
kills only that sub-plot, because the correction is what actually fed the verdict.

---

## Two things the docs don't tell you

Both were found by running against the live testnet, and both will bite anyone
building here.

### 1. `strike: "0"` is a sentinel, not a missing field

Every live series returns `strike: "0"`. They are **relative** contracts:

```
"question": "BTC closes at or above its opening price"
```

The settlement reference is the underlying's price at `tradingStart`, not a fixed
number. Treating the `0` as a strike gives `distance_to_strike = Infinity` — a
value that looks like a signal, reads as overwhelming conviction, and means
nothing. Agent Arena resolves the real reference from the price-feed candle
covering `tradingStart` (`MarketSource.referencePrice()`), and reports
`UNRESOLVED` rather than guessing when it cannot.

### 2. Windows are 15m / 1h / 4h / 24h

Not 5 minutes. Two consequences: a council has genuine room to deliberate, and a
**15-minute contract can open, settle, and be scored inside a live demo**. Most
prediction-market demos stop at "here is our prediction". This one closes the loop
on stage.

---

## Architecture

```
apps/web              War room UI (Next.js) — belief timeline, evidence split,
                       debate feed, counterfactual replay, reputation pages
backend/               FastAPI + LangGraph — council orchestration, holds long-
                       lived clients to BOTH MCP servers below, Python port of
                       the Black Box (same JSONL wire format as the TS one)
packages/
  arena-trade-mcp      Privileged MCP server — proposal economics, risk checks,
                       order preview. No tool here can send a real order.
  arena-mcp            Read-only MCP server — market discovery, evidence, the
                       circularity audit (audit_citations)
  arena-trade          Proposal → risk validation → gated execution → settlement
                       → scoring (the TS library arena-trade-mcp wraps)
  arena-reputation     Calibration (Brier + Murphy's decomposition), skill vs.
                       market, agent lineage/forking
  arena-market         The MarketSource seam: live DreamDEX adapter + offline
                       fixtures
  arena-core           The Prediction Black Box (TS)
  ec-core              Vendored MIT wrapper from the official dreamdex-bot-kit
  arena-agents         Superseded — the pre-Python-pivot TS council. Kept
                       uncommitted; the real council is backend/app/agents/.
```

`MarketSource` is the only place the SDK is imported. Everything above it talks to
an interface with two implementations — live and fixtures — which means the demo
runs with no network, agents are testable without spending tokens against a moving
market, and when the venue ids move (they have changed three times in one week)
exactly one file changes.

`BlackBox` is append-only with **explicit causality**: every event names the events
that caused it. Without that you have a chronology, not a flight recorder — you
cannot answer "which evidence caused this" or run a counterfactual, both of which
this repo actually does. Two independent implementations (TypeScript in
`arena-core`, Python in `backend/app/blackbox.py`) agree on nothing except the
JSONL shape on disk — which is the whole interoperability contract, and is what
lets the TypeScript reputation tools score a session the Python council wrote
without either language importing the other.

---

## Safety

Read-only analysis and privileged trading are separate MCP servers, and the
privileged one is privileged only in scope — **it has no tool that can send a real
order.** MCP has no protocol-level way to distinguish "a human clicked approve"
from "an LLM client decided to call this tool," so rather than build an
`execute_trade` tool and hope callers only invoke it after real confirmation, the
trading server never loads a signer at all: `arena-trade`'s own two-gate
`execute()` logic (`DRY_RUN=false` **and** an explicit approval) refuses to send
without one, and this process structurally never has one. The one place a real
order can be sent in this codebase is `arena-trade/src/cli.ts`'s `terminalGate()`
— a human, at a real terminal, typing `yes`.

Development runs on Shannon testnet. Every proposal is risk-validated before it
can be approved, and every prediction is timestamped in the Black Box before its
outcome is known.

---

## Quick start

```bash
pnpm install
cp .env.example .env          # testnet, read-only, DRY_RUN=true by default

pnpm run check                # verify you can see live event contracts
pnpm run check -- --fixtures  # same, with no network at all
```

`pnpm run check` is the first thing to run and the last thing to run before a demo.
The venue ids move, and this is the only thing that tells you they moved *before*
the council is on screen.

### Running the pieces

```bash
pnpm run mcp                          # the read-only intelligence server, standalone
pnpm exec tsx packages/arena-trade-mcp/scripts/smoke.ts   # trading server, live

pnpm run leaderboard -- --demo        # reputation scoring against a synthetic corpus
pnpm --filter @arena/web run dev      # war room UI, http://localhost:3100

cd backend && python -m venv .venv && .venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m uvicorn app.main:app --reload   # FastAPI backend
```

The backend spawns both MCP servers itself as child processes over stdio — you do
not run them separately when using the backend.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `NETWORK` | `testnet` | Shannon, chain 50312 |
| `DRY_RUN` | `true` | Necessary but not sufficient to trade |
| `VENUE_ID` | — | Testnet has **two** venues; scope to dreamDEX or reads throw |
| `PRIVATE_KEY` | unset | Read-only without it. Leave unset for rehearsals |
| `PRICE_FEED_URL` | bundled on testnet | Without it every directional claim is circular |
| `ANTHROPIC_API_KEY` | unset | Required for the council to actually run |
| `ARENA_MODEL` | `claude-opus-5` | |
| `ARENA_FIXTURES` | `false` | `true` runs the whole stack offline |

---

## Credits

`packages/ec-core` is vendored from
[somnia-chain/dreamdex-bot-kit](https://github.com/somnia-chain/dreamdex-bot-kit)
(MIT). It encodes hard-won venue behaviour — float price corruption on 18-decimal
venues, lot-grid snapping, reverted writes that resolve without throwing, pool
recycling across windows — that would otherwise have to be relearned the expensive
way.
