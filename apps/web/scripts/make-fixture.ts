/**
 * Hand-authored council session -> `fixtures/session.jsonl`.
 *
 * Every number here was worked out on paper before it was typed, because the
 * whole UI is a projection of this file and a fixture whose causality does not
 * line up produces a war room that lies. Specifically:
 *
 *   - `causedBy` is real. `strike_distance` is caused by the spot read AND the
 *     window-open read, because it is literally computed from both. That is what
 *     makes the counterfactual view worth looking at: delete the settlement
 *     reference and the entire session collapses, which is the true answer.
 *   - Probabilities move for stated reasons and the arithmetic checks out
 *     (distances in bps, Brier scores, edge vs. spread).
 *   - The session settles NO by 1.87bps, so scoring is real rather than notional.
 *
 * Run: pnpm --filter @arena/web fixture
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BlackBoxEvent,
  EventId,
  RecordedEvent,
  Signal,
  SignalOrigin,
} from "@arena/core/blackbox.js";

const SESSION = "sess_20260822T1415Z_btc15m";

// ---------------------------------------------------------------------------
// The window. A live DreamDEX 15m relative contract on BTC.
// ---------------------------------------------------------------------------
const tradingStart = Math.floor(Date.parse("2026-08-22T14:15:00Z") / 1000);
const INTERVAL = 900;
const expiry = tradingStart + INTERVAL; // 14:30:00Z
const MARKET = "0x7ad3c41f9b2e5a8104d6ee3b77c2f0915ab4d6e2";

/** The reference YES must beat. `strike` on the wire is the 0 sentinel. */
const WINDOW_OPEN = 76_412.5;

const bps = (px: number, ref: number) => +(((px - ref) / ref) * 10_000).toFixed(2);

// t0 observation: 488s into a 900s window.
const T1 = tradingStart + 488; // 412s left, 54.2% elapsed
const SPOT1 = 76_489.2; // +10.04bps
const MARK1 = 76_470.1; // spot vs EMA = +2.50bps

// t1 re-observation mid-debate: the lead narrows while the book gets LOUDER.
const T2 = tradingStart + 712; // 188s left, 79.1% elapsed
const SPOT2 = 76_471.4; // +7.71bps

const SETTLE_PX = 76_398.2; // -1.87bps -> settles NO, by a hair.

// ---------------------------------------------------------------------------
// Recorder. Mirrors BlackBox.record(), but with controlled wall-clock stamps so
// the recorded session sits at a fixed, reproducible point in its window.
// ---------------------------------------------------------------------------
const events: RecordedEvent[] = [];
function rec(event: BlackBoxEvent, causedBy: EventId[], atSec: number): EventId {
  const seq = events.length;
  const id: EventId = `${SESSION}:${seq}`;
  events.push({ ...event, id, seq, ts: atSec * 1000, causedBy });
  return id;
}

function sig(
  s: Omit<Signal, "observedAt"> & { observedAt: number },
  causedBy: EventId[],
  atSec: number,
): EventId {
  return rec({ kind: "signal_captured", signal: s }, causedBy, atSec);
}

const S = (
  id: string,
  label: string,
  value: number | string,
  origin: SignalOrigin,
  source: string,
  observedAt: number,
  staleness: number,
  unit?: string,
): Signal => ({ id, label, value, origin, source, observedAt, staleness, ...(unit ? { unit } : {}) });

// ===========================================================================
// 1. The market generation being acted on.
// ===========================================================================
const eMarket = rec(
  {
    kind: "market_observed",
    marketId: MARKET,
    symbol: `BTC-15M-${expiry}`,
    strike: 0, // SENTINEL. Relative contract; reference is the window open.
    expiry,
    intervalSec: INTERVAL,
    status: 1,
    yesMid: 0.58,
    yesBid: 0.56,
    yesAsk: 0.6,
  },
  [],
  T1 - 2,
);

// ===========================================================================
// 2. Evidence capture, t0. Independent first, book last — and every derived
//    signal points at the reads it was computed from.
// ===========================================================================
const eTimeLeft = sig(
  S("time_left", "Seconds to expiry", 412, "clock", "system clock", T1, 0, "s"),
  [eMarket],
  T1,
);
const eElapsed = sig(
  S("window_elapsed", "Window elapsed", 54.2, "clock", "system clock", T1, 0, "%"),
  [eMarket, eTimeLeft],
  T1,
);
const eRef = sig(
  S(
    "reference_price",
    "Window open price",
    WINDOW_OPEN,
    "underlying",
    "price-feed 1m candle at tradingStart 14:15:00Z",
    tradingStart,
    0,
  ),
  [eMarket],
  T1,
);
const eSpot = sig(
  S("spot", "BTC spot", SPOT1, "underlying", "dreamDEX price feed", T1 - 2, 2),
  [],
  T1,
);
const eDist = sig(
  S(
    "strike_distance",
    "Distance from window open",
    bps(SPOT1, WINDOW_OPEN), // +10.04
    "underlying",
    `spot ${SPOT1} vs window open ${WINDOW_OPEN}`,
    T1 - 2,
    2,
    "bps",
  ),
  [eSpot, eRef],
  T1,
);
const eMomentum = sig(
  S(
    "momentum",
    "Spot vs EMA mark",
    bps(SPOT1, MARK1), // +2.50
    "underlying",
    "dreamDEX price feed (EMA-60)",
    T1 - 47, // deliberately stale: trips the >30s freshness audit.
    47,
    "bps",
  ),
  [eSpot],
  T1,
);
const eVol = sig(
  S(
    "realized_vol",
    "Realized move, 1 window",
    38.4,
    "underlying",
    "price feed, trailing 32x 15m windows, |close-open| mean",
    T1 - 4,
    4,
    "bps",
  ),
  [],
  T1,
);
const eReversion = sig(
  S(
    "reversion_3w",
    "Prior 3 windows, close vs open",
    "-4.1 / +2.6 / -7.0",
    "underlying",
    "price feed, 3 trailing 15m candles",
    T1 - 6,
    6,
    "bps",
  ),
  [],
  T1,
);
const eOracle = sig(
  S(
    "settlement_oracle",
    "Settlement oracle heartbeat",
    4,
    "chain",
    "MarketOracle.latestRound() @ Shannon 50312",
    T1 - 4,
    0,
    "s",
  ),
  [],
  T1,
);
// --- The book. Recorded so the council knows what it is betting against.
//     Tagged so nobody mistakes it for a reason.
const eImplied = sig(
  S(
    "market_implied",
    "Market-implied P(YES)",
    58.0,
    "book",
    "dreamDEX orderbook, yesMid",
    T1 - 3,
    3,
    "%",
  ),
  [eMarket],
  T1,
);
const eSpread = sig(
  S("spread", "YES bid-ask spread", 4.0, "derived", "derived from orderbook", T1 - 3, 3, "pp"),
  [eMarket],
  T1,
);
const eLiq = sig(
  S("liquidity_quality", "Book quality", "wide", "derived", "derived from spread", T1 - 3, 0),
  [eSpread],
  T1,
);

// ===========================================================================
// 3. Opening theses. Genuine disagreement: 71 / 44 / 52 / 58 / 55.
// ===========================================================================
const eBull1 = rec(
  {
    kind: "belief_stated",
    belief: {
      agent: "bull",
      p: 0.71,
      confidence: 0.62,
      rationale:
        "BTC is +10.04bps above the window open with 412s left, and the EMA mark is still below spot. " +
        "YES does not need a rally — it needs the tape not to give back ten basis points in under seven minutes. " +
        "The sign is already correct and time is on its side.",
      cites: ["strike_distance", "momentum", "time_left"],
    },
  },
  [eDist, eMomentum, eTimeLeft],
  T1 + 9,
);

const eBear1 = rec(
  {
    kind: "belief_stated",
    belief: {
      agent: "bear",
      p: 0.44,
      confidence: 0.55,
      rationale:
        "10.04bps is 0.26 of one window's mean realized move (38.4bps). That is not a lead, it is where the " +
        "tape happened to be standing when we looked. Three of the last three windows closed within 7bps of " +
        "their open, two of them negative. Slightly under even.",
      cites: ["realized_vol", "reversion_3w", "strike_distance"],
    },
  },
  [eVol, eReversion, eDist],
  T1 + 11,
);

const eForensics1 = rec(
  {
    kind: "belief_stated",
    belief: {
      agent: "forensics",
      p: 0.52,
      confidence: 0.4,
      rationale:
        "Evidence quality read, not a directional one. The settlement reference resolved cleanly from the 1m " +
        "candle at tradingStart, so 'above' has a referent here. The oracle is 4s fresh. One weak point: the " +
        "EMA momentum read is 47s old on a window with 412s left.",
      cites: ["reference_price", "settlement_oracle", "strike_distance"],
    },
  },
  [eRef, eOracle, eDist],
  T1 + 13,
);

// The circular mistake, made in public. This is the one the venue makes easiest.
const eAdv1 = rec(
  {
    kind: "belief_stated",
    belief: {
      agent: "adversarial",
      p: 0.58,
      confidence: 0.5,
      rationale:
        "The book is at 58% and this venue's short windows are efficient. Flow is the aggregate of everyone " +
        "who can see the same tape we can, so the price is the estimate. I take the market's number.",
      cites: ["market_implied"],
    },
  },
  [eImplied],
  T1 + 15,
);

const eRisk1 = rec(
  {
    kind: "belief_stated",
    belief: {
      agent: "risk",
      p: 0.55,
      confidence: 0.3,
      rationale:
        "Not a directional view — a tradeability read. The YES book is 4.0pp wide, which is 'wide' on this " +
        "series and eats two full points of any edge on entry alone. Whatever the council concludes, the " +
        "conclusion has to clear the spread before it is worth anything.",
      cites: ["spread", "liquidity_quality", "time_left"],
    },
  },
  [eSpread, eLiq, eTimeLeft],
  T1 + 17,
);

// ===========================================================================
// 4. The debate.
// ===========================================================================

// FATAL — the mechanical citation audit fires before the LLM does.
const eChal1 = rec(
  {
    kind: "challenge_issued",
    from: "forensics",
    against: "adversarial",
    claim:
      "Your 58% cites exactly one signal and it is `market_implied` — the contract's own book. The book IS " +
      "the market's probability estimate. Citing it as grounds for a directional view is not analysis, it is " +
      "restating the price with extra words. You have no independent basis for this number.",
    severity: "fatal",
    targets: eAdv1,
  },
  [eAdv1, eImplied],
  T1 + 24,
);

// MATERIAL — the variance argument.
const eChal2 = rec(
  {
    kind: "challenge_issued",
    from: "bear",
    against: "bull",
    claim:
      "You priced 71% off a 10.04bps lead when one window's mean realized move is 38.4bps. That is 0.26 sigma. " +
      "You are reading noise as direction, and 71% is a conviction number on what is close to a coin flip.",
    severity: "material",
    targets: eBull1,
  },
  [eBull1, eVol, eDist],
  T1 + 27,
);

// MINOR — freshness.
const eChal3 = rec(
  {
    kind: "challenge_issued",
    from: "forensics",
    against: "bull",
    claim:
      "Your `momentum` cite was observed 47s ago on a 900s window with 412s left. The indexer lags the chain; " +
      "a 47s-old EMA read describes a market that no longer exists. Drop it or re-read it.",
    severity: "minor",
    targets: eBull1,
  },
  [eBull1, eMomentum],
  T1 + 29,
);

// MATERIAL — the adversarial agent, doing its actual job.
const eChal4 = rec(
  {
    kind: "challenge_issued",
    from: "adversarial",
    against: "bear",
    claim:
      "You told Bull that 10bps inside a 38bps distribution is noise, then built a tilt out of `reversion_3w` — " +
      "three observations. n=3 is an anecdote, not a base rate. Apply your own variance argument to your own " +
      "evidence and that leg disappears.",
    severity: "material",
    targets: eBear1,
  },
  [eBear1, eReversion],
  T1 + 32,
);

// --- Responses.

// Adversarial concedes the fatal finding and re-grounds on independent evidence.
const eAdv2 = rec(
  {
    kind: "belief_revised",
    from: 0.58,
    supersedes: eAdv1,
    belief: {
      agent: "adversarial",
      p: 0.5,
      confidence: 0.35,
      rationale:
        "Conceded, and it is the worst kind of error because it sounded like analysis. I restated the price " +
        "and called it a view. Re-grounding on what is actually independent: +10bps with 412s left, inside " +
        "one-window vol. The honest answer with no directional evidence of my own is even.",
      cites: ["time_left", "strike_distance", "window_elapsed"],
    },
  },
  [eChal1],
  T1 + 41,
);

// Bull moves. This is the event the product exists to capture.
const eBull2 = rec(
  {
    kind: "belief_revised",
    from: 0.71,
    supersedes: eBull1,
    belief: {
      agent: "bull",
      p: 0.64,
      confidence: 0.58,
      rationale:
        "Bear's sigma argument lands and Forensics is right that I leaned on a 47s-old EMA read. Dropping " +
        "`momentum`. I keep a tilt because the sign is positive and 54% of the window is already spent — the " +
        "remaining distribution is narrower than the full-window one Bear is quoting — but 71% priced " +
        "conviction the evidence does not carry.",
      cites: ["strike_distance", "time_left", "window_elapsed", "spot"],
    },
  },
  [eChal2, eChal3],
  T1 + 45,
);

// Bear holds. Also informative.
const eBearHold = rec(
  {
    kind: "belief_held",
    agent: "bear",
    p: 0.44,
    because:
      "Adversarial is right that n=3 is thin, and I am not treating it as a base rate — it is one of three " +
      "legs and the weakest. The load-bearing leg is that 10bps is 0.26 sigma, which does not depend on the " +
      "reversion series at all. Bull's move to 64% concedes exactly that point. Holding 44%.",
  },
  [eChal4],
  T1 + 49,
);

// ===========================================================================
// 5. Re-observation at 188s. The independent lead NARROWS while the book gets
//    LOUDER. This is the whole thesis of the product in one frame.
// ===========================================================================
const eSpot2 = sig(
  S("spot", "BTC spot", SPOT2, "underlying", "dreamDEX price feed", T2 - 1, 1),
  [],
  T2,
);
const eTimeLeft2 = sig(
  S("time_left", "Seconds to expiry", 188, "clock", "system clock", T2, 0, "s"),
  [eMarket],
  T2,
);
const eElapsed2 = sig(
  S("window_elapsed", "Window elapsed", 79.1, "clock", "system clock", T2, 0, "%"),
  [eMarket, eTimeLeft2],
  T2,
);
const eDist2 = sig(
  S(
    "strike_distance",
    "Distance from window open",
    bps(SPOT2, WINDOW_OPEN), // +7.71
    "underlying",
    `spot ${SPOT2} vs window open ${WINDOW_OPEN}`,
    T2 - 1,
    1,
    "bps",
  ),
  [eSpot2, eRef],
  T2,
);
const eImplied2 = sig(
  S(
    "market_implied",
    "Market-implied P(YES)",
    68.5,
    "book",
    "dreamDEX orderbook, yesMid (YES lifted 58.0 -> 68.5 on 3 prints)",
    T2 - 1,
    1,
    "%",
  ),
  [eMarket],
  T2,
);
const eSpread2 = sig(
  S("spread", "YES bid-ask spread", 5.0, "derived", "derived from orderbook", T2 - 1, 1, "pp"),
  [eMarket],
  T2,
);
const eLiq2 = sig(
  S("liquidity_quality", "Book quality", "wide", "derived", "derived from spread", T2 - 1, 0),
  [eSpread2],
  T2,
);

// --- Everyone updates on the new independent read. Nobody updates on the book.
const eBull3 = rec(
  {
    kind: "belief_revised",
    from: 0.64,
    supersedes: eBull2,
    belief: {
      agent: "bull",
      p: 0.61,
      confidence: 0.6,
      rationale:
        "The lead narrowed to +7.71bps. Against that, only 188s remain — 79% of the window is spent, so the " +
        "distribution of what is left is roughly 0.45 of a full window, about 17bps. +7.7bps against 17bps is " +
        "a real edge for the sign persisting. Slightly lower, still clearly above even.",
      cites: ["strike_distance", "time_left", "window_elapsed"],
    },
  },
  [eDist2, eTimeLeft2, eElapsed2],
  T2 + 8,
);

const eBear2 = rec(
  {
    kind: "belief_revised",
    from: 0.44,
    supersedes: eBearHold,
    belief: {
      agent: "bear",
      p: 0.47,
      confidence: 0.58,
      rationale:
        "Time works against my thesis and I am not going to pretend otherwise. At 188s the remaining " +
        "distribution is narrow enough that the current sign persists more often than not, so I move up. " +
        "I do not move to Bull's 61%: +7.7bps against ~17bps of remaining move is under half a sigma, and " +
        "the book's 68.5% is pricing something closer to certainty than that supports.",
      cites: ["strike_distance", "time_left", "realized_vol"],
    },
  },
  [eDist2, eTimeLeft2],
  T2 + 11,
);

const eAdv3 = rec(
  {
    kind: "belief_revised",
    from: 0.5,
    supersedes: eAdv2,
    belief: {
      agent: "adversarial",
      p: 0.54,
      confidence: 0.42,
      rationale:
        "Same arithmetic as Bear's update, landing on the other side of even. Sign persistence at 188s is a " +
        "real effect and it is the only independent thing I can point at. Note that I am now BELOW the book " +
        "I was quoting an hour of debate ago, which is what it looks like to have actually updated.",
      cites: ["time_left", "strike_distance", "window_elapsed"],
    },
  },
  [eDist2, eTimeLeft2],
  T2 + 13,
);

const eForensics2 = rec(
  {
    kind: "belief_revised",
    from: 0.52,
    supersedes: eForensics1,
    belief: {
      agent: "forensics",
      p: 0.55,
      confidence: 0.5,
      rationale:
        "The freshness objection is resolved: the new spot read is 1s old and the stale EMA is out of every " +
        "citation on the board. The record now supports a directional claim, so my number moves with the sign " +
        "rather than sitting at even out of caution.",
      cites: ["spot", "strike_distance", "reference_price"],
    },
  },
  [eSpot2, eDist2],
  T2 + 15,
);

const eRiskHold = rec(
  {
    kind: "belief_held",
    agent: "risk",
    p: 0.55,
    because:
      "Nothing in the re-observation changes tradeability, and the spread widened 4.0 -> 5.0pp as the book " +
      "lifted. My number is not a forecast and should not be averaged into one.",
  },
  [eSpread2, eLiq2],
  T2 + 17,
);

// A last challenge that lands on the book, not on an agent.
const eChal5 = rec(
  {
    kind: "challenge_issued",
    from: "forensics",
    against: "judge",
    claim:
      "Before you weigh anything: the book moved 58.0 -> 68.5 while the only independent read got WEAKER " +
      "(+10.04 -> +7.71bps). Nothing in the evidence set justifies that repricing. If the verdict drifts " +
      "toward 68.5 it will be because the council read the price, not the tape.",
    severity: "material",
    targets: eImplied2,
  },
  [eImplied2, eDist2],
  T2 + 20,
);

// ===========================================================================
// 6. Verdict. Weighted toward the agents with independent grounding; Risk is
//    excluded from the average because its number is not a forecast.
//    bull .61 / bear .47 / forensics .55 / adversarial .54  ->  .5925 -> .59
// ===========================================================================
const eJudge1 = rec(
  {
    kind: "belief_stated",
    belief: {
      agent: "judge",
      p: 0.59,
      confidence: 0.66,
      rationale:
        "Four directional views, all now grounded in the same two independent facts: +7.71bps and 188s. " +
        "They differ on how much a sub-half-sigma lead is worth this late, which is a real disagreement and " +
        "I am not going to smooth it. I take Forensics' point on the book: I am weighing the tape, not the " +
        "price. Risk's 55% is excluded — it is a tradeability read, not a forecast.",
      cites: ["strike_distance", "time_left", "window_elapsed", "realized_vol"],
    },
  },
  [eBull3, eBear2, eAdv3, eForensics2, eChal5],
  T2 + 31,
);

const eVerdict = rec(
  {
    kind: "verdict",
    p: 0.59,
    spread: 0.14,
    dissent:
      "Bull at 61% and Bear at 47% is a genuine 14-point disagreement about one question: how much of a " +
      "7.71bps lead survives 188 seconds. Bull's remaining-window variance argument is the better piece of " +
      "reasoning on the board and it is why I sit above even. Bear's counter — that the book's 68.5% prices " +
      "near-certainty on under half a sigma — is the better read of the MARKET, and it is why the edge here " +
      "is on the NO side even though the council leans YES. Adversarial's opening was circular and was " +
      "withdrawn; I have given its final 54% full weight because the revision was substantive.",
  },
  [eJudge1],
  T2 + 33,
);

// ===========================================================================
// 7. Edge. Council 59% YES vs book 68.5% YES. NO is the underpriced side.
//    NO council 41.0%  vs  NO market 31.5%  ->  +9.5pp
// ===========================================================================
const eEdge = rec(
  {
    kind: "edge_computed",
    marketImplied: 0.685,
    councilP: 0.59,
    edge: -0.095,
  },
  [eVerdict, eImplied2],
  T2 + 35,
);

const eProp = rec(
  {
    kind: "trade_proposed",
    side: "NO",
    limitPrice: 0.335,
    size: 250,
    maxLoss: 83.75,
    invalidation:
      "Abandon if spot prints more than +18bps above the window open (the lead becomes real), or with fewer " +
      "than 45s left (no time to be filled and no time to be wrong cheaply).",
  },
  [eEdge, eVerdict],
  T2 + 38,
);

const eRiskVerdict = rec(
  {
    kind: "risk_verdict",
    ok: true,
    concerns: [
      "Gross edge is 9.5pp on NO. The YES book is 5.0pp wide, so entry costs ~2.5pp of half-spread: net edge ~7.0pp, above the 3.0pp floor but not by a lot.",
      "188s to expiry. There is no managing this position — it is a hold-to-settlement bet and the invalidation rule will almost certainly not have time to fire.",
      "Council spread is 14pp. A verdict with this much live disagreement sizes at half normal notional; 250 contracts IS the halved size.",
      "Max loss 83.75 USDC against a 5,000 USDC session cap. Within limits.",
    ],
  },
  [eProp, eSpread2, eLiq2, eRisk1],
  T2 + 41,
);

// The §14 gate. A human, named, on this specific proposal.
const eApproved = rec(
  { kind: "trade_approved", actor: "operator:0x4f2a…c19b" },
  [eRiskVerdict, eProp],
  T2 + 58,
);

const eExec = rec(
  {
    kind: "trade_executed",
    txHash: "0x9c1f7ae2b48d0c6531fa77e9b0d2c4a815e3f96072bb4d1c8ea5379046f2ab7d",
    dryRun: false,
    filled: 250,
  },
  [eApproved],
  T2 + 61,
);

// ===========================================================================
// 8. Settlement and scoring. Closes NO by 1.87bps.
// ===========================================================================
const eSettled = rec(
  { kind: "settled", outcome: "NO", settlementPrice: SETTLE_PX },
  [eExec, eOracle],
  expiry + 12,
);

/** Brier for a NO outcome is simply p². Kept explicit so the file is checkable. */
const brierNo = (p: number) => +(p * p).toFixed(4);

const scores: Array<{
  agent: "bull" | "bear" | "forensics" | "adversarial" | "risk" | "judge";
  p: number;
  revisions: number;
  helpful: number;
  from: EventId;
}> = [
  { agent: "bull", p: 0.61, revisions: 2, helpful: 2, from: eBull3 },
  { agent: "bear", p: 0.47, revisions: 1, helpful: 0, from: eBear2 },
  { agent: "forensics", p: 0.55, revisions: 1, helpful: 0, from: eForensics2 },
  { agent: "adversarial", p: 0.54, revisions: 2, helpful: 1, from: eAdv3 },
  { agent: "risk", p: 0.55, revisions: 0, helpful: 0, from: eRisk1 },
  { agent: "judge", p: 0.59, revisions: 0, helpful: 0, from: eJudge1 },
];

for (const s of scores) {
  rec(
    {
      kind: "scored",
      agent: s.agent,
      p: s.p,
      brier: brierNo(s.p),
      // Accuracy on a near-even binary is close to noise; recorded because the
      // schema asks for it, but Brier is the number that means anything.
      correct: s.p < 0.5,
      revisions: s.revisions,
      revisionsHelpful: s.helpful,
    },
    [eSettled, s.from],
    expiry + 20,
  );
}

// ---------------------------------------------------------------------------
// Emit.
// ---------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "fixtures", "session.jsonl");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

// Sanity: causality must only ever point backwards, or replay and the
// counterfactual single-pass both quietly break.
const seen = new Set<EventId>();
for (const e of events) {
  for (const c of e.causedBy) {
    if (!seen.has(c)) throw new Error(`${e.id} (${e.kind}) cites future/unknown cause ${c}`);
  }
  seen.add(e.id);
}

console.log(`wrote ${events.length} events -> ${out}`);
console.log(`  session   ${SESSION}`);
console.log(`  market    ${MARKET}`);
console.log(`  window    ${new Date(tradingStart * 1000).toISOString()} -> ${new Date(expiry * 1000).toISOString()} (${INTERVAL}s)`);
console.log(`  reference ${WINDOW_OPEN} (strike sentinel 0, relative contract)`);
console.log(`  settled   ${SETTLE_PX} = ${bps(SETTLE_PX, WINDOW_OPEN)}bps -> NO`);
console.log(`  council   0.59 vs book 0.685 -> edge +9.5pp on NO`);
