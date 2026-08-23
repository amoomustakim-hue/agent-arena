/**
 * The live DreamDEX adapter. The only file in the project that imports the SDK.
 *
 * Thin on purpose: `ec-core` already encodes the venue's sharp edges (venue
 * scoping, pool recycling, the 18-decimal float trap), and re-deriving any of
 * that here would mean re-learning it the expensive way.
 */

import {
  createExchange,
  activeMarkets,
  marketOnchain,
  outcomeSymbols,
  snapshot,
  shutdown,
  explainEmptyScope,
  type EcContext,
} from "@dreamdex-bot-kit/ec-core";
import type { ArenaMarket, Book, MarketSource, Reference, Underlying } from "./index.js";

/** Extract the fields we need off a binary market row. */
function toArenaMarket(m: any): ArenaMarket | null {
  const info = m?.info;
  if (!info || info.marketType !== "BINARY") return null;
  const { yes, no } = outcomeSymbols(m);
  const strike = Number(info.strike ?? 0);
  return {
    marketId: String(info.marketId),
    // Built from structured fields, never from question text — the kit's
    // gotcha #12 records that the wording has changed repeatedly.
    symbol: `${info.asset ?? "?"} ${info.interval ?? `${info.intervalSec}s`} @${info.expiry}`,
    asset: String(info.asset ?? "?"),
    strike,
    // The live series all ship strike 0 and settle against the window's own
    // opening price. See ArenaMarket.strike for why this distinction matters.
    isRelative: !(strike > 0),
    tradingStart: Number(info.tradingStart ?? 0),
    expiry: Number(info.expiry ?? 0),
    intervalSec: Number(info.intervalSec ?? 0),
    status: m.active ? 1 : 0, // indicative only — refreshStatus() is authoritative
    question: String(info.question ?? ""),
    yesSymbol: yes,
    noSymbol: no,
  };
}

export class LiveMarketSource implements MarketSource {
  readonly mode = "live" as const;
  private readonly ctx: EcContext;
  /** Symbol lookup by marketId, so callers pass ids and we keep the SDK rows. */
  private readonly rows = new Map<string, any>();
  /** A window's open price never changes once set — resolve it once. */
  private readonly refCache = new Map<string, Reference>();

  private constructor(ctx: EcContext) {
    this.ctx = ctx;
  }

  /** Read-only by default. `withSigner` opens a key and is required to trade. */
  static create(opts: { withSigner?: boolean } = {}): LiveMarketSource {
    return new LiveMarketSource(createExchange(opts));
  }

  get context(): EcContext {
    return this.ctx;
  }

  async discover(opts: { asset?: string; max?: number } = {}): Promise<ArenaMarket[]> {
    const rows = await activeMarkets(this.ctx, opts);
    if (rows.length === 0) {
      // Silence here is the worst outcome — a stale VENUE_ID looks exactly like
      // a quiet market. ec-core can tell the two apart, so let it.
      throw new Error(`No active event contracts: ${await explainEmptyScope(this.ctx)}`);
    }
    const out: ArenaMarket[] = [];
    for (const r of rows) {
      const m = toArenaMarket(r);
      if (m) {
        this.rows.set(m.marketId, r);
        out.push(m);
      }
    }
    // Soonest expiry first: the nearest window is the one a demo can settle.
    return out.sort((a, b) => a.expiry - b.expiry).slice(0, opts.max ?? out.length);
  }

  /**
   * The authoritative on-chain status. Always call this before acting on a
   * market — the indexer's `active` flag lags by seconds (gotcha #1), and on a
   * five-minute contract "seconds" is a meaningful fraction of the whole life.
   */
  async refreshStatus(marketId: string): Promise<number> {
    const row = this.rows.get(marketId);
    if (!row) throw new Error(`Unknown marketId ${marketId} — call discover() first.`);
    const chain = await marketOnchain(this.ctx, row);
    return chain?.status ?? -1;
  }

  async book(market: ArenaMarket, depth = 5): Promise<Book> {
    const snap = await snapshot(this.ctx, market.yesSymbol, depth);
    return { ...snap, readAt: Date.now() };
  }

  /**
   * The underlying BTC/ETH price. Returns undefined rather than throwing when
   * no feed is configured, because "we are blind" is a fact the council must
   * reason about, not an error that aborts the session. `extractSignals`
   * records the absence explicitly.
   */
  async underlying(asset: string): Promise<Underlying | undefined> {
    if (!this.ctx.config.priceFeed) return undefined;
    try {
      const p: any = await this.ctx.exchange.fetchPrice(asset);
      const spot = Number(p?.price ?? p?.spot ?? NaN);
      if (!Number.isFinite(spot)) return undefined;
      const mark = Number(p?.mark ?? p?.ema ?? NaN);
      // Prefer the feed's own timestamp. Falling back to "now" would report
      // staleness 0 for arbitrarily old data — silently disarming the check.
      const observedAt = Number(p?.timestamp ?? p?.updatedAt ?? Math.floor(Date.now() / 1000));
      return {
        asset,
        spot,
        ...(Number.isFinite(mark) ? { mark } : {}),
        observedAt: observedAt > 1e12 ? Math.floor(observedAt / 1000) : observedAt,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * What YES actually has to beat.
   *
   * Absolute-strike markets answer this off the row. Relative markets — which
   * is every live series today — settle against the underlying's price when
   * the window opened, so we read the OPEN of the price-feed candle covering
   * `tradingStart`. That is the same number the oracle will settle against,
   * rather than an approximation of it.
   *
   * Cached: a window's open price is immutable once the window has opened, and
   * a council re-reading it every pass would be paying for a constant.
   */
  async referencePrice(market: ArenaMarket): Promise<Reference | undefined> {
    if (!market.isRelative) {
      return { price: market.strike, source: "strike", observedAt: market.tradingStart };
    }
    const hit = this.refCache.get(market.marketId);
    if (hit) return hit;
    if (!market.tradingStart || !this.ctx.config.priceFeed) return undefined;

    try {
      const sinceMs = market.tradingStart * 1000;
      // [ts, open, high, low, close, volume] — CCXT ordering.
      const candles: number[][] = await (this.ctx.exchange as any).fetchPriceOHLCV(
        market.asset,
        "1m",
        sinceMs,
        3,
      );
      // The candle that CONTAINS tradingStart, not merely the first returned:
      // asking `since` can hand back the following minute if the window opened
      // mid-candle, and that open is a different (wrong) price.
      const minuteMs = 60_000;
      const bucket = Math.floor(sinceMs / minuteMs) * minuteMs;
      const row = candles.find((c) => c[0] === bucket) ?? candles[0];
      const open = row?.[1];
      if (row === undefined || open === undefined || !Number.isFinite(open)) return undefined;

      const ref: Reference = { price: open, source: "window_open", observedAt: Math.floor(row[0]! / 1000) };
      this.refCache.set(market.marketId, ref);
      return ref;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    await shutdown(this.ctx);
  }
}
