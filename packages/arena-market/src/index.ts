/**
 * The seam between Agent Arena and DreamDEX.
 *
 * Everything above this line (agents, MCP, UI) talks to `MarketSource` and
 * never imports the SDK. Two implementations satisfy it — the live venue and
 * recorded fixtures — which buys three things that matter on a deadline:
 *
 *   - The demo runs with no network. A venue outage at 3pm on demo day is not
 *     a project-ending event, it is `ARENA_FIXTURES=true`.
 *   - Agents are testable without spending tokens against a moving market.
 *   - The venue ids move (the kit warns they changed three times in one week).
 *     When they move, one file changes.
 */

export interface ArenaMarket {
  marketId: string;
  symbol: string;
  asset: string;
  /**
   * The absolute price YES needs the underlying to close above — or 0.
   *
   * ZERO IS A SENTINEL, NOT A MISSING VALUE. The live DreamDEX series are
   * RELATIVE contracts ("BTC closes at or above its opening price"), where the
   * reference is the underlying's price at `tradingStart` rather than a fixed
   * number. Treating a 0 here as a real strike yields an infinite distance and
   * a council arguing about nothing. Use `referencePrice()`, never this field.
   */
  strike: number;
  /** True when `strike` is the 0 sentinel and the reference is the open price. */
  isRelative: boolean;
  /** Unix seconds when the window opened — the reference instant when relative. */
  tradingStart: number;
  /** Unix seconds when the window closes. */
  expiry: number;
  /** Window length. Live venue runs 900 / 3600 / 14400 / 86400. */
  intervalSec: number;
  /** On-chain MarketStatus. Only 1 (Trading) accepts orders. */
  status: number;
  /** The venue's own wording. For DISPLAY ONLY — never parse numbers out of it
   *  (the kit's gotcha #12: the wording has changed repeatedly). */
  question: string;
  yesSymbol: string;
  noSymbol: string;
}

/**
 * The price the underlying must beat for YES to settle true, and where that
 * number came from. `undefined` means we could not establish it — which the
 * council must be told, not have papered over with a guess.
 */
export interface Reference {
  price: number;
  source: "strike" | "window_open";
  /** For `window_open`: the candle instant the open was read from. */
  observedAt: number;
}

export interface Book {
  bestYesBid?: number;
  bestYesAsk?: number;
  /** Market-implied probability of YES, in (0,1). The number the council is
   *  trying to beat. Undefined when the book is empty — which is common on a
   *  freshly-spawned window and must not be faked as 0.5. */
  yesMid?: number;
  /** When this book was read. */
  readAt: number;
}

/** The underlying BTC/ETH price. The ONLY non-circular directional input. */
export interface Underlying {
  asset: string;
  spot: number;
  /** EMA mark, when the feed provides one. */
  mark?: number;
  /** When the feed produced this — not when we read it. */
  observedAt: number;
}

export interface MarketSource {
  readonly mode: "live" | "fixture";
  /** Active binary markets on the DreamDEX venue, soonest expiry first. */
  discover(opts?: { asset?: string; max?: number }): Promise<ArenaMarket[]>;
  /** Authoritative on-chain status. The indexer lags; this does not. */
  refreshStatus(marketId: string): Promise<number>;
  book(market: ArenaMarket, depth?: number): Promise<Book>;
  /** Undefined when no price feed is configured — mainnet has none bundled. */
  underlying(asset: string): Promise<Underlying | undefined>;
  /** Resolve what YES actually needs to beat. Undefined if unknowable. */
  referencePrice(market: ArenaMarket): Promise<Reference | undefined>;
  close(): Promise<void>;
}

export const isTradable = (status: number) => status === 1;

/** Seconds until expiry. Negative past it. */
export const secondsLeft = (m: ArenaMarket, now = Date.now()) => m.expiry - Math.floor(now / 1000);

/**
 * Is there enough window left to be worth convening a council?
 *
 * Scaled to the series interval rather than fixed, per the kit's gotcha #8: a
 * flat 300s floor rejects every market on a 5-minute venue. A council that
 * finishes after expiry produced an opinion about the past.
 */
export const hasHeadroom = (m: ArenaMarket, fraction = 0.25) =>
  secondsLeft(m) > Math.max(30, m.intervalSec * fraction);

export * from "./signals.js";
