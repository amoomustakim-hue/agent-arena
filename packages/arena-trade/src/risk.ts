/**
 * The component whose job is to say no.
 *
 * Risk validation runs AFTER the proposal and BEFORE the approval gate, so a
 * human is never asked to approve something already known to be unsendable.
 * Every check here corresponds to a way an order actually fails on this venue,
 * and each returns a concern the operator can act on rather than a boolean.
 *
 * Checks are ordered cheapest-first and never short-circuit: an operator
 * deserves the full list, not the first objection.
 */

import type { ArenaMarket, Book } from "@arena/market";
import { secondsLeft } from "@arena/market";
import { headroomSec, MARKET_STATUS, type MarketOnchain } from "@dreamdex-bot-kit/ec-core";
import type { Proposal } from "./propose.js";
import type { VenueGrid } from "./venue.js";

export interface RiskVerdict {
  ok: boolean;
  concerns: string[];
  /** Concerns that are advisory rather than blocking. */
  warnings: string[];
}

export interface RiskInput {
  proposal: Proposal;
  market: ArenaMarket;
  book: Book;
  onchain: MarketOnchain;
  grid: VenueGrid;
  /** Collateral actually available, when the caller could read it. */
  balance?: number;
  /** Hard cap on collateral per position, regardless of what was proposed. */
  maxPosition?: number;
}

export function assess(input: RiskInput): RiskVerdict {
  const { proposal, market, book, onchain, grid } = input;
  const concerns: string[] = [];
  const warnings: string[] = [];

  // --- Tradability. The indexer lags; this snapshot is the chain's own answer.
  if (onchain.status !== MARKET_STATUS.Trading) {
    const name = ["Listed", "Trading", "Locked", "Settling", "Resolved", "Voided"][onchain.status];
    concerns.push(
      `Market is ${name} (status ${onchain.status}), not Trading. It will not accept orders. ` +
        `The indexer may still be showing it as active — the chain is authoritative.`,
    );
  }
  if (onchain.isVoided) concerns.push("Market is VOIDED. Positions settle to nothing.");
  if (onchain.finalized) concerns.push("Market is already finalized. Nothing to trade.");

  // --- Time. Scaled to the series interval, not a fixed floor: a flat 300s
  // rejects every 900s market outright, which is most of this venue.
  const left = secondsLeft(market);
  const floor = headroomSec(market.intervalSec);
  if (left <= 0) {
    concerns.push(`Window closed ${-left}s ago.`);
  } else if (left < floor) {
    concerns.push(
      `Only ${left}s left against a ${Math.round(floor)}s floor for a ${market.intervalSec}s window. ` +
        `Too little time for the thesis to play out, and the order may outlive the market.`,
    );
  } else if (left < floor * 1.5) {
    warnings.push(`${left}s left is close to the ${Math.round(floor)}s floor. Expect little room to manage the position.`);
  }

  // --- Spread against the claimed edge. A wide book eats thin edges whole.
  if (book.bestYesBid !== undefined && book.bestYesAsk !== undefined) {
    const spread = book.bestYesAsk - book.bestYesBid;
    if (spread >= proposal.evPerShare * 2) {
      concerns.push(
        `Spread is ${(spread * 100).toFixed(1)}pp against ${(proposal.evPerShare * 100).toFixed(2)}pp of edge. ` +
          `Round-tripping this position costs more than the edge is worth — you would need to hold to settlement.`,
      );
    } else if (spread >= proposal.evPerShare) {
      warnings.push(
        `Spread ${(spread * 100).toFixed(1)}pp is comparable to the ${(proposal.evPerShare * 100).toFixed(2)}pp edge. ` +
          `Exiting early will not be profitable; this is a hold-to-settlement trade.`,
      );
    }
  } else {
    concerns.push("Book is one-sided or empty — no reliable exit, and the fill price is unpredictable.");
  }

  // --- Grid sanity. `placeLimit` snaps and returns a zero-size no-op rather
  // than throwing, so a bad size fails SILENTLY unless caught here.
  if (grid.quantize(proposal.size) <= 0) {
    concerns.push(`Size ${proposal.size} floors to 0 on the ${grid.lotHuman} lot grid. placeLimit would silently send nothing.`);
  }
  if (Math.abs(grid.snapPrice(proposal.limitPrice) - proposal.limitPrice) > 1e-9) {
    concerns.push(`Price ${proposal.limitPrice} is not on the ${grid.tickHuman} tick grid and will be rejected as InvalidPrice.`);
  }
  if (!(proposal.limitPrice > 0 && proposal.limitPrice < 1)) {
    concerns.push(`Price ${proposal.limitPrice} is outside (0,1). A probability of 0 or 1 is a certainty, not a price.`);
  }

  // --- Economics. Re-derived here rather than trusted from the proposal, so a
  // bug upstream cannot smuggle a negative-EV trade past the gate.
  if (proposal.evPerShare <= 0) {
    concerns.push(`EV per share is ${proposal.evPerShare.toFixed(4)} — not positive. This proposal should not exist.`);
  }
  if (proposal.councilP <= proposal.breakeven) {
    concerns.push(
      `Council probability ${(proposal.councilP * 100).toFixed(1)}% does not clear the ` +
        `${(proposal.breakeven * 100).toFixed(1)}% breakeven after settlement fees.`,
    );
  }
  if (proposal.councilP > 0.97 || proposal.councilP < 0.03) {
    warnings.push(
      `Council is at ${(proposal.councilP * 100).toFixed(1)}% — near-certainty on a market ` +
        `the venue prices near even. Treat extreme confidence as a signal to re-check the evidence.`,
    );
  }

  // --- Funding.
  if (input.balance !== undefined && proposal.maxLoss > input.balance) {
    concerns.push(`Position costs ${proposal.maxLoss} but only ${input.balance} collateral is available.`);
  }
  if (input.maxPosition !== undefined && proposal.maxLoss > input.maxPosition) {
    concerns.push(`Position costs ${proposal.maxLoss}, over the ${input.maxPosition} per-position cap.`);
  }

  return { ok: concerns.length === 0, concerns, warnings };
}
