/**
 * The process-wide venue context for the trading server.
 *
 * Unlike `arena-mcp`, this process needs `ec-core`'s live exchange context
 * directly (not just `MarketSource`) — proposal economics and risk checks read
 * the tick/lot grid and settlement fees, which live on `EcContext`, not on the
 * `ArenaMarket` shape the read-only server exposes.
 *
 * No signer is ever requested here. See server.ts for why: every tool in this
 * process stops one step short of a real send, so there is nothing for a
 * signer to do.
 */

import { createExchange, activeMarkets, marketOnchain, type EcContext } from "@dreamdex-bot-kit/ec-core";
import { venueGrid, venueFees, type VenueGrid, type VenueFees } from "@arena/trade";
import type { MarketOnchain, UnifiedMarket } from "@dreamdex-bot-kit/ec-core";
import type { ArenaMarket, MarketSource } from "@arena/market";

export const log = (msg: string) => process.stderr.write(`[arena-trade-mcp] ${msg}\n`);

export const usingFixtures = () =>
  process.env.ARENA_FIXTURES === "true" || process.argv.includes("--fixtures");

let ctx: EcContext | null = null;
let source: MarketSource | null = null;
const rows = new Map<string, UnifiedMarket>();
const cache = new Map<string, ArenaMarket>();
let lastDiscover = 0;

/** Lazily built, read-only. `withSigner` is never passed — see server.ts. */
export function getContext(): EcContext {
  if (!ctx) {
    ctx = createExchange();
    log(`mode: live (network=${ctx.config.network}, signer=${ctx.canTrade})`);
  }
  return ctx;
}

export async function getSource(): Promise<MarketSource> {
  if (source) return source;
  if (usingFixtures()) {
    const { FixtureMarketSource } = await import("@arena/market/fixtures.js");
    source = FixtureMarketSource.synthetic();
    log("mode: fixtures (synthetic, no network)");
  } else {
    const { LiveMarketSource } = await import("@arena/market/live.js");
    source = LiveMarketSource.create();
  }
  return source!; // just assigned on one of the two branches above
}

export async function discover(opts: { asset?: string; max?: number } = {}): Promise<ArenaMarket[]> {
  const src = await getSource();
  const markets = await src.discover(opts);
  for (const m of markets) cache.set(m.marketId, m);
  lastDiscover = Date.now();

  // Also warm the raw-row cache `venueGrid`/`onchainOf` need, by asking
  // ec-core directly — `MarketSource` deliberately does not expose the raw
  // SDK rows, and grid/fee math needs them.
  if (!usingFixtures()) {
    const c = getContext();
    const raw = await activeMarkets(c, opts);
    for (const r of raw) rows.set(String((r.info as any).marketId), r);
  }
  return markets;
}

export async function resolve(marketId: string): Promise<ArenaMarket> {
  if (!cache.has(marketId) || Date.now() - lastDiscover > 15_000) {
    await discover({ max: 50 }).catch(() => undefined);
  }
  const m = cache.get(marketId);
  if (!m) {
    throw new Error(`Unknown marketId ${marketId}. Call propose_trade after checking discover_markets ` +
      `on the intelligence server first.`);
  }
  return m;
}

export async function onchain(marketId: string): Promise<MarketOnchain> {
  if (usingFixtures()) {
    // Fixtures carry no real chain state; synthesize a Trading snapshot
    // consistent enough for the grid/fee math these tools exercise.
    return {
      status: 1,
      isVoided: false,
      isResolved: false,
      finalized: false,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 300),
      winningOutcome: -1,
    } as unknown as MarketOnchain;
  }
  const c = getContext();
  const row = rows.get(marketId);
  if (!row) await discover({ max: 50 });
  const r = rows.get(marketId);
  if (!r) throw new Error(`Unknown marketId ${marketId} — not in the current active set.`);
  const oc = await marketOnchain(c, r);
  if (!oc) throw new Error(`${marketId} did not resolve to a binary market on-chain.`);
  return oc;
}

export function grid(): VenueGrid {
  return venueGrid(getContext());
}

export async function fees(marketId: string, oc: MarketOnchain) {
  if (usingFixtures()) {
    return { settlementBps: 0, takerBps: 0, source: "fixtures — assumed 0" } as VenueFees;
  }
  return venueFees(getContext(), marketId, oc);
}

export async function shutdown(): Promise<void> {
  await source?.close().catch(() => undefined);
  source = null;
  ctx = null;
}
