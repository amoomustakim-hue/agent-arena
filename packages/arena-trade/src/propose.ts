/**
 * Verdict → trade proposal.
 *
 * The one thing this module refuses to do is flatter the council. An edge is
 * the difference between what you believe and what you PAY, after costs — not
 * the difference between your probability and the mid. Three costs get
 * forgotten, and each of them has flipped a "profitable" trade to negative:
 *
 *   1. THE SPREAD. You buy at the ask, not the mid. Believing 65% against a mid
 *      of 60% looks like 5pp of edge; if the ask is 63% it is 2pp.
 *
 *   2. THE SETTLEMENT FEE. A winning share redeems for `1 − fee`, not 1. So the
 *      breakeven probability is `price / (1 − fee)`, strictly above the price.
 *      This is the one people miss (see venue.ts).
 *
 *   3. THE TICK GRID. The price you actually send is snapped. Compute the edge
 *      on the snapped price, because that is the price you will pay.
 *
 * `null` is a first-class answer. A council that disagrees with the market by
 * less than it costs to act has produced information, not a trade, and saying
 * so is the correct output.
 */

import type { ArenaMarket, Book, Reference } from "@arena/market";
import { secondsLeft } from "@arena/market";
import type { Probability } from "@arena/core";
import type { VenueGrid, VenueFees } from "./venue.js";

export interface Proposal {
  marketId: string;
  outcome: "YES" | "NO";
  side: "buy";
  /** Probability in the chosen leg's own terms, snapped to the tick grid. */
  limitPrice: number;
  /** Shares, snapped to the lot grid. */
  size: number;
  /** Expected value per share after all costs. Positive by construction. */
  evPerShare: number;
  /** Total collateral at risk. For a buy this is the entire premium. */
  maxLoss: number;
  /** Probability the leg settles true, in that leg's terms. */
  councilP: Probability;
  /** What the market charges for that leg right now. */
  marketP: Probability;
  /** Probability at which this trade breaks even, after fees. */
  breakeven: number;
  /** How the order will be sent. */
  orderType: "post-only" | "ioc";
  /** What would prove the thesis wrong before expiry. */
  invalidation: string;
  reasoning: string;
}

/** Why no trade. Returned instead of a proposal so the record says what was
 *  considered and rejected, rather than going silent. */
export interface NoTrade {
  reason: string;
  detail: string;
}

export interface ProposeInput {
  market: ArenaMarket;
  book: Book;
  reference: Reference | undefined;
  /** The council's probability that YES settles true. */
  councilP: Probability;
  grid: VenueGrid;
  fees: VenueFees;
  /** Collateral the operator is willing to put at risk on one contract. */
  budget: number;
  /** Minimum EV per share to bother. Guards against acting on noise. */
  minEv?: number;
  /** `post-only` rests and may not fill; `ioc` crosses and pays the spread. */
  orderType?: "post-only" | "ioc";
}

export function propose(input: ProposeInput): Proposal | NoTrade {
  const { market, book, councilP, grid, fees, budget } = input;
  const minEv = input.minEv ?? 0.02;
  const orderType = input.orderType ?? "ioc";
  const feeMult = 1 - fees.settlementBps / 10_000;

  if (book.yesMid === undefined) {
    return {
      reason: "no book",
      detail:
        "The market has no two-sided book, so there is no price to trade against. " +
        "Do not substitute 0.5 — an absent book is missing information, not an even chance.",
    };
  }

  // Which leg? Above the market means buy YES; below means buy NO. Only buys:
  // selling requires inventory this package does not assume you hold.
  const outcome: "YES" | "NO" = councilP > book.yesMid ? "YES" : "NO";
  const legP = outcome === "YES" ? councilP : 1 - councilP;

  // The price you actually PAY. Crossing takes the far side of the book;
  // resting sits on the near side and may never fill. Using the mid here is the
  // single most common way to invent an edge that does not exist.
  const yesAsk = book.bestYesAsk ?? book.yesMid;
  const yesBid = book.bestYesBid ?? book.yesMid;
  const payYes = orderType === "ioc" ? yesAsk : yesBid;
  const rawLegPrice = outcome === "YES" ? payYes : 1 - payYes;

  const limitPrice = grid.snapPrice(rawLegPrice);
  if (!(limitPrice > 0 && limitPrice < 1)) {
    return {
      reason: "price off grid",
      detail: `Leg price ${rawLegPrice.toFixed(4)} snaps to ${limitPrice}, outside (0,1). Nothing sendable.`,
    };
  }

  // EV per share, after the settlement fee. Buy at `limitPrice`; a winner
  // redeems for `1 - fee`; a loser redeems for nothing.
  const evPerShare = legP * feeMult - limitPrice;
  const breakeven = limitPrice / feeMult;

  // Only narrate the fee when there is one. Testnet runs at 0bps, and
  // "breakeven is 56.1%, not 56.1%" reads as a broken calculation.
  const feeClause =
    fees.settlementBps > 0
      ? `, and a winning share redeems for ${(feeMult * 100).toFixed(2)}% after the ` +
        `${fees.settlementBps}bps settlement fee, putting breakeven at ${(breakeven * 100).toFixed(1)}%`
      : ` (settlement fee is 0bps here, so breakeven is just the price)`;

  if (evPerShare < minEv) {
    const mktLeg = outcome === "YES" ? book.yesMid : 1 - book.yesMid;
    return {
      reason: "edge does not clear costs",
      detail:
        `Council ${(legP * 100).toFixed(1)}% on ${outcome} vs market ${(mktLeg * 100).toFixed(1)}% (mid). ` +
        `But you pay ${(limitPrice * 100).toFixed(1)}% ${orderType === "ioc" ? "crossing the spread" : "resting"}` +
        `${feeClause}. ` +
        `EV is ${(evPerShare * 100).toFixed(2)}pp/share against a ${(minEv * 100).toFixed(0)}pp floor. ` +
        `This is information, not a trade.`,
    };
  }

  // Size to the budget, then snap DOWN to the lot grid. A size that floors to
  // zero must be skipped, never sent.
  const size = grid.quantize(budget / limitPrice);
  if (size <= 0) {
    return {
      reason: "size below one lot",
      detail:
        `Budget ${budget} at ${limitPrice.toFixed(3)} buys ${(budget / limitPrice).toFixed(4)} shares, ` +
        `which floors to 0 on a ${grid.lotHuman} lot grid. Raise the budget or skip.`,
    };
  }

  const left = secondsLeft(market);
  const refText = input.reference
    ? input.reference.source === "window_open"
      ? `the window's opening price of ${input.reference.price}`
      : `the strike of ${input.reference.price}`
    : "an UNRESOLVED settlement reference";

  return {
    marketId: market.marketId,
    outcome,
    side: "buy",
    limitPrice,
    size,
    evPerShare,
    maxLoss: +(limitPrice * size).toFixed(6),
    councilP: legP,
    marketP: outcome === "YES" ? book.yesMid : 1 - book.yesMid,
    breakeven,
    orderType,
    invalidation:
      outcome === "YES"
        ? `${market.asset} falling back below ${refText} with under ${Math.round(left * 0.3)}s left, ` +
          `or the book bid for YES dropping below ${(limitPrice * 0.75).toFixed(3)}.`
        : `${market.asset} rising back above ${refText} with under ${Math.round(left * 0.3)}s left, ` +
          `or the book bid for NO dropping below ${(limitPrice * 0.75).toFixed(3)}.`,
    reasoning:
      `Council puts ${outcome} at ${(legP * 100).toFixed(1)}%; the market charges ` +
      `${(limitPrice * 100).toFixed(1)}% ${orderType === "ioc" ? "at the ask" : "resting at the bid"}. ` +
      (fees.settlementBps > 0
        ? `After the ${fees.settlementBps}bps settlement fee breakeven is ${(breakeven * 100).toFixed(1)}%, leaving `
        : `Settlement fee is 0bps here, so breakeven is the price itself, leaving `) +
      `${(evPerShare * 100).toFixed(2)}pp of edge per share. ` +
      `${size} shares risks ${(limitPrice * size).toFixed(4)} collateral. ` +
      `Settles against ${refText}, ${left}s from now.`,
  };
}

export const isProposal = (r: Proposal | NoTrade): r is Proposal => "outcome" in r;
