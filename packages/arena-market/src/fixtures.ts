/**
 * Recorded / synthetic markets. Same interface as the live venue.
 *
 * This is demo insurance, not a toy. Testnet venues respawn markets on a
 * schedule and their ids move; a live-only demo is one outage away from
 * nothing to show. It is also how the council gets tested without paying for
 * tokens against a market that has already expired by the second run.
 *
 * `record()` captures a real session so the demo can replay a market that
 * genuinely happened, including its settlement.
 */

import { writeFile, readFile } from "node:fs/promises";
import type { ArenaMarket, Book, MarketSource, Reference, Underlying } from "./index.js";

export interface Fixture {
  market: ArenaMarket;
  book: Book;
  underlying?: Underlying;
  reference?: Reference;
  /** Known result, when the fixture was captured after settlement. Lets the
   *  scoring and replay path be exercised without waiting for a real expiry. */
  outcome?: "YES" | "NO" | "VOID";
}

export class FixtureMarketSource implements MarketSource {
  readonly mode = "fixture" as const;
  private readonly fixtures: Fixture[];
  /** Anchor expiries to load time so a saved fixture never looks expired. */
  private readonly loadedAt = Math.floor(Date.now() / 1000);

  constructor(fixtures: Fixture[]) {
    this.fixtures = fixtures;
  }

  static async load(path: string): Promise<FixtureMarketSource> {
    return new FixtureMarketSource(JSON.parse(await readFile(path, "utf8")));
  }

  /** Capture live state to disk for later replay. */
  static async record(source: MarketSource, path: string, max = 5): Promise<number> {
    const markets = await source.discover({ max });
    const out: Fixture[] = [];
    for (const market of markets) {
      const book = await source.book(market);
      const underlying = await source.underlying(market.asset);
      const reference = await source.referencePrice(market);
      out.push({
        market,
        book,
        ...(underlying ? { underlying } : {}),
        ...(reference ? { reference } : {}),
      });
    }
    await writeFile(path, JSON.stringify(out, null, 2), "utf8");
    return out.length;
  }

  /**
   * A synthetic market that is always mid-window and always interesting.
   *
   * Defaults put spot slightly ABOVE the strike with the book priced near even
   * — a genuine disagreement, so Bull and Bear both have something honest to
   * say and the council is not unanimous by construction.
   */
  static synthetic(opts: { asset?: string; intervalSec?: number; distanceBps?: number; yesMid?: number } = {}): FixtureMarketSource {
    const asset = opts.asset ?? "BTC";
    // 900s mirrors the venue's shortest live series.
    const intervalSec = opts.intervalSec ?? 900;
    const openPrice = 76_500;
    const spot = openPrice * (1 + (opts.distanceBps ?? 12) / 10_000);
    const now = Math.floor(Date.now() / 1000);
    const tradingStart = now - Math.floor(intervalSec * 0.4);
    const expiry = tradingStart + intervalSec;
    const yesMid = opts.yesMid ?? 0.54;
    return new FixtureMarketSource([
      {
        market: {
          marketId: "0xfixture0001",
          symbol: `${asset} 15m @${expiry}`,
          asset,
          // Mirrors the live venue: relative contract, strike sentinel 0.
          strike: 0,
          isRelative: true,
          tradingStart,
          expiry,
          intervalSec,
          status: 1,
          question: `${asset} closes at or above its opening price`,
          yesSymbol: `${asset}-${expiry}#YES`,
          noSymbol: `${asset}-${expiry}#NO`,
        },
        book: {
          bestYesBid: +(yesMid - 0.015).toFixed(3),
          bestYesAsk: +(yesMid + 0.015).toFixed(3),
          yesMid,
          readAt: Date.now(),
        },
        underlying: { asset, spot: +spot.toFixed(2), mark: +(spot * 0.99988).toFixed(2), observedAt: now },
        reference: { price: openPrice, source: "window_open", observedAt: tradingStart },
      },
    ]);
  }

  /** Shift stored expiries forward by however long the fixture has been on
   *  disk, so replays sit at the same point in the window as when captured. */
  private shift(m: ArenaMarket): ArenaMarket {
    if (m.expiry > this.loadedAt) return m;
    return { ...m, expiry: this.loadedAt + Math.floor(m.intervalSec * 0.6) };
  }

  async discover(opts: { asset?: string; max?: number } = {}): Promise<ArenaMarket[]> {
    return this.fixtures
      .filter((f) => !opts.asset || f.market.asset === opts.asset)
      .slice(0, opts.max ?? this.fixtures.length)
      .map((f) => this.shift(f.market));
  }

  async refreshStatus(marketId: string): Promise<number> {
    return this.fixtures.find((f) => f.market.marketId === marketId)?.market.status ?? -1;
  }

  async book(market: ArenaMarket): Promise<Book> {
    const f = this.fixtures.find((x) => x.market.marketId === market.marketId);
    if (!f) throw new Error(`No fixture for ${market.marketId}`);
    return { ...f.book, readAt: Date.now() };
  }

  async underlying(asset: string): Promise<Underlying | undefined> {
    const f = this.fixtures.find((x) => x.market.asset === asset && x.underlying);
    if (!f?.underlying) return undefined;
    // Re-stamp to now: a saved timestamp would read as hours stale and trip the
    // freshness audit on every replay, which would be an artifact of the
    // fixture rather than a real finding.
    return { ...f.underlying, observedAt: Math.floor(Date.now() / 1000) };
  }

  async referencePrice(market: ArenaMarket): Promise<Reference | undefined> {
    const f = this.fixtures.find((x) => x.market.marketId === market.marketId);
    if (f?.reference) return f.reference;
    if (!market.isRelative && market.strike > 0) {
      return { price: market.strike, source: "strike", observedAt: market.tradingStart };
    }
    return undefined;
  }

  outcomeOf(marketId: string): "YES" | "NO" | "VOID" | undefined {
    return this.fixtures.find((f) => f.market.marketId === marketId)?.outcome;
  }

  async close(): Promise<void> {}
}
