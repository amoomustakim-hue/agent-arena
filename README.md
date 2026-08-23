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
after settlement to see exactly which piece of evidence moved which belief.

The whole thing sits on MCP, so the analysis tools are reusable by any agent, and
the privileged trading tools are a separate server that a read-only client cannot
reach.

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
failures specific to this venue, not on a script.

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
apps/web            War room UI — belief timelines, replay scrubber, approval gate
packages/
  arena-agents      The AI Trading Court: bull, bear, forensics, adversarial, risk, judge
  arena-trade       Proposal → risk validation → approval gate → execution → settlement → scoring
  arena-mcp         Read-only intelligence MCP server
  arena-market      The MarketSource seam: live DreamDEX adapter + offline fixtures
  arena-core        The Prediction Black Box
  ec-core           Vendored MIT wrapper from the official dreamdex-bot-kit
```

`MarketSource` is the only place the SDK is imported. Everything above it talks to
an interface with two implementations — live and fixtures — which means the demo
runs with no network, agents are testable without spending tokens against a moving
market, and when the venue ids move (they have changed three times in one week)
exactly one file changes.

`BlackBox` is append-only with **explicit causality**: every event names the events
that caused it. Without that you have a chronology, not a flight recorder — you can
show that a probability moved at 14:03 but not why, and the entire replay feature
becomes unanswerable.

---

## Safety

Read-only analysis and privileged trading are separate servers. Execution requires
**two independent gates**: `DRY_RUN=false` *and* an explicit human approval for that
specific proposal. Neither alone is sufficient. Development runs on Shannon testnet.
Every proposal is risk-validated before it can be approved, and every predication is
timestamped in the Black Box before its outcome is known.

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

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `NETWORK` | `testnet` | Shannon, chain 50312 |
| `DRY_RUN` | `true` | Necessary but not sufficient to trade |
| `VENUE_ID` | — | Testnet has **two** venues; scope to dreamDEX or reads throw |
| `PRIVATE_KEY` | unset | Read-only without it. Leave unset for rehearsals |
| `PRICE_FEED_URL` | bundled on testnet | Without it every directional claim is circular |
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
