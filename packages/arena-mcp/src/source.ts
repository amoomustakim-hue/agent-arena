/**
 * The process-wide MarketSource, plus a marketId → row cache.
 *
 * MCP tools are stateless calls, but `ArenaMarket` rows are what every other
 * tool needs to do its job, and `LiveMarketSource` can only resolve a marketId
 * it has already seen through `discover()`. So the first call to any tool warms
 * the cache, and later calls resolve ids against it rather than making the
 * client re-run discovery to ask a follow-up question.
 */

import type { ArenaMarket, MarketSource } from "@arena/market";

let source: MarketSource | null = null;
const cache = new Map<string, ArenaMarket>();
let lastDiscover = 0;

/** stdout is the MCP protocol channel. Anything written there corrupts the
 *  stream and the client disconnects with a parse error — so all diagnostics
 *  go to stderr, always. This is the single easiest way to break an MCP
 *  server, and it fails in a way that looks like the server never started. */
export const log = (msg: string) => process.stderr.write(`[arena-mcp] ${msg}\n`);

export const usingFixtures = () =>
  process.env.ARENA_FIXTURES === "true" || process.argv.includes("--fixtures");

export async function getSource(): Promise<MarketSource> {
  if (source) return source;
  if (usingFixtures()) {
    const { FixtureMarketSource } = await import("@arena/market/fixtures.js");
    source = FixtureMarketSource.synthetic();
    log("mode: fixtures (synthetic, no network)");
  } else {
    const { LiveMarketSource } = await import("@arena/market/live.js");
    // Read-only: no signer is ever opened by this server. See server.ts.
    source = LiveMarketSource.create();
    log("mode: live");
  }
  return source;
}

/** Refresh the market cache. Cheap enough to run often; windows respawn on a
 *  schedule, so a cache older than ~20s can be pointing at a dead market. */
export async function discover(opts: { asset?: string; max?: number } = {}): Promise<ArenaMarket[]> {
  const src = await getSource();
  const markets = await src.discover(opts);
  for (const m of markets) cache.set(m.marketId, m);
  lastDiscover = Date.now();
  return markets;
}

/**
 * Resolve a marketId, discovering first if we have not looked recently.
 *
 * Throws a message naming what the client should do rather than returning
 * undefined — a tool that silently returns "not found" for a market that does
 * exist sends the caller hunting in the wrong place.
 */
export async function resolve(marketId: string): Promise<ArenaMarket> {
  if (!cache.has(marketId) || Date.now() - lastDiscover > 20_000) {
    await discover({ max: 50 }).catch(() => undefined);
  }
  const m = cache.get(marketId);
  if (!m) {
    const known = [...cache.keys()].slice(0, 5);
    throw new Error(
      `Unknown marketId ${marketId}. Call discover_markets first. ` +
        (known.length ? `Currently known: ${known.join(", ")}` : "No active markets found."),
    );
  }
  return m;
}

export async function shutdown(): Promise<void> {
  await source?.close().catch(() => undefined);
  source = null;
}
