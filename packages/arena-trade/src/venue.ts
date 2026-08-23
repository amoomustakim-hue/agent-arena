/**
 * The venue's arithmetic, in one place.
 *
 * Everything here exists because an event-contract order is not a float. The
 * venue has a TICK grid for prices and a LOT grid for sizes, and a number that
 * misses either grid is rejected on-chain rather than rounded for you. `ec-core`
 * already converts correctly on the way out (`placeLimit`, `quantize`); what it
 * does not do is let you SEE the integers before you commit — and a gated
 * executor that claims to "log the exact order that would have been sent" has to
 * show the integers, not the floats they came from.
 *
 * So this module mirrors ec-core's private `toSteps` for preview and validation
 * only. The real conversion still happens inside `placeLimit`. If the two ever
 * disagree, `placeLimit` is right and this is a bug.
 */

import {
  quantize as ecQuantize,
  toRawUnits,
  type EcContext,
  type MarketOnchain,
  type UnifiedMarket,
} from "@dreamdex-bot-kit/ec-core";

/** The tick/lot grid a market's orders must land on. */
export interface VenueGrid {
  decimals: number;
  tick: bigint;
  lot: bigint;
  /** Smallest price increment, human units (testnet 0.001, mainnet 0.001). */
  tickHuman: number;
  /** Smallest size increment, human units. */
  lotHuman: number;
  /** Snap a probability to the tick grid the way `placeLimit` will. */
  snapPrice(p: number): number;
  /** Snap a size DOWN to the lot grid. 0 means TOO SMALL TO SEND — skip, never send. */
  quantize(shares: number): number;
  /** The integer price the pool will actually see, in the leg's own terms. */
  rawPrice(p: number): bigint;
  /** The integer quantity the pool will actually see. */
  rawSize(shares: number): bigint;
  /** A NO order is quoted to the book as the YES complement. Integer subtraction. */
  rawPriceYes(p: number, outcome: "YES" | "NO"): bigint;
}

export function venueGrid(ctx: EcContext): VenueGrid {
  const { decimals, tick, lot } = ctx.config;
  const one = 10n ** BigInt(decimals);
  // Small integers by construction (1000 on an 18-decimal venue with a 1e15
  // tick), which is the whole point: `Math.round` on a number this size absorbs
  // the float epsilon. Multiplying by 10^18 — which is what the SDK's unified
  // `createOrder` does via `parseUnits(price.toFixed(18), 18)` — is the bug this
  // avoids: `(0.05).toFixed(18)` is "0.050000000000000003", three wei off grid,
  // and the pool answers `InvalidPrice`.
  const ticksPerOne = Number(one / tick);
  const lotsPerOne = Number(one / lot);

  const rawPrice = (p: number): bigint =>
    BigInt(Math.max(0, Math.round(p * ticksPerOne))) * tick;

  return {
    decimals,
    tick,
    lot,
    tickHuman: Number(tick) / 10 ** decimals,
    lotHuman: Number(lot) / 10 ** decimals,
    snapPrice: (p: number) => Math.round(p * ticksPerOne) / ticksPerOne,
    quantize: (shares: number) => ecQuantize(ctx, shares),
    rawPrice,
    rawSize: (shares: number) =>
      BigInt(Math.max(0, Math.floor(shares * lotsPerOne + 1e-9))) * lot,
    rawPriceYes: (p: number, outcome: "YES" | "NO") =>
      outcome === "YES" ? rawPrice(p) : one - rawPrice(p),
  };
}

/** Human → raw collateral units, exact at any decimals. Re-exported so callers
 *  do not reach for `parseUnits` and reintroduce the float trap. */
export const rawCollateral = (human: number, decimals: number): bigint =>
  toRawUnits(human, decimals);

/**
 * The authoritative on-chain snapshot for a market id.
 *
 * This is a CHAIN read, so it works on markets `loadMarkets()` cannot see —
 * which is every settled market since markets-sdk 0.20 dropped finalized
 * binaries from the registry sweep. Settlement depends on that.
 *
 * Hold ONE snapshot for a pass and reuse it. Pools are recycled across windows,
 * so re-reading mid-pass can straddle a generation.
 */
export async function onchainOf(ctx: EcContext, marketId: string): Promise<MarketOnchain> {
  return ctx.exchange.client.getMarketOnchain(marketId as `0x${string}`);
}

/**
 * The minimal `UnifiedMarket` shape the write helpers actually read.
 *
 * `placeLimit` uses `market.symbol` for its revert label and takes everything
 * authoritative off `onchain`; `redeemOutcome` uses `info.marketId` and
 * `info.marketType`. ec-core's own `claimSettled` builds exactly this stub for
 * the same reason — a settled market has no registry row to hand you.
 */
export function marketStub(marketId: string, symbol: string): UnifiedMarket {
  return {
    symbol,
    info: { marketType: "BINARY", marketId },
  } as unknown as UnifiedMarket;
}

/** The fee drag on a round trip, in basis points of notional. */
export interface VenueFees {
  /** Skimmed from the WINNING payout at redeem — a winner pays `1 − fee`, not 1:1. */
  settlementBps: number;
  /** Charged on a crossing fill. Null when the market pre-dates the fee plumbing. */
  takerBps: number;
  /** How each number was obtained, for the record. */
  source: string;
}

/**
 * Read the fees frozen into a market.
 *
 * Both matter to an edge calculation and both are easy to forget. The
 * settlement fee is the one people miss: buy YES at 0.60 believing 0.65 and you
 * have not made 5pp, you have made `0.65·(1−fee) − 0.60`. On a thin edge that
 * sign can flip.
 *
 * Never throws: an unreachable indexer must not stop a proposal, it must make
 * the proposal more conservative. Unknown fees fall back to 0 and say so, and
 * the caller can decide whether trading blind on fees is acceptable.
 */
export async function venueFees(
  ctx: EcContext,
  marketId: string,
  onchain?: MarketOnchain,
): Promise<VenueFees> {
  let settlementBps = 0;
  let takerBps = 0;
  const notes: string[] = [];
  try {
    const fees = await ctx.exchange.client.getMarketFees(marketId);
    if (fees?.settlementFeeBps != null) {
      settlementBps = Number(fees.settlementFeeBps);
      notes.push("settlement=indexer");
    }
    if (fees?.takerFeeBps != null) {
      takerBps = Number(fees.takerFeeBps);
      notes.push("taker=indexer");
    }
  } catch {
    notes.push("indexer unreachable");
  }
  if (!notes.some((n) => n.startsWith("settlement"))) {
    // Fall back to ec-core, which reads the settlement record for a finalized
    // market and the pool's frozen params for a live one — never the pool of a
    // finalized market, because that pool is probably serving someone else now.
    try {
      const { settlementFeeBps } = await import("@dreamdex-bot-kit/ec-core");
      settlementBps = Number(
        await settlementFeeBps(ctx, marketStub(marketId, marketId), onchain),
      );
      notes.push("settlement=chain");
    } catch (e) {
      notes.push(`settlement=UNKNOWN (${(e as Error).message.slice(0, 60)})`);
    }
  }
  if (!notes.some((n) => n.startsWith("taker"))) notes.push("taker=UNKNOWN, assumed 0");
  return { settlementBps, takerBps, source: notes.join(", ") };
}
