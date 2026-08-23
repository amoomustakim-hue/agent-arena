/**
 * Phase 1 proof: can Agent Arena see DreamDEX event contracts?
 *
 * Read-only. Never opens a signer, never sends anything. Run this first, and
 * run it again before every demo — the venue ids move, and this is the only
 * thing that tells you they moved BEFORE the council is on screen.
 *
 *   pnpm doctor              # live venue
 *   pnpm doctor --fixtures   # synthetic, no network
 *   pnpm doctor --record x.json
 */

import { extractSignals, hasHeadroom, secondsLeft, isCircular } from "./index.js";
import { FixtureMarketSource } from "./fixtures.js";
import type { MarketSource } from "./index.js";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => argv[argv.indexOf(f) + 1];

const pct = (n?: number) => (n === undefined ? "  —  " : `${(n * 100).toFixed(1)}%`);

async function main() {
  const useFixtures = has("--fixtures") || process.env.ARENA_FIXTURES === "true";

  let source: MarketSource;
  if (useFixtures) {
    source = FixtureMarketSource.synthetic();
    console.log("mode      fixture (synthetic, no network)\n");
  } else {
    const { LiveMarketSource } = await import("./live.js");
    const live = LiveMarketSource.create();
    source = live;
    const c = live.context.config;
    console.log(`mode      live`);
    console.log(`network   ${c.network} (chain ${c.chainId})`);
    console.log(`indexer   ${c.indexerUrl}`);
    console.log(`venue     ${c.venueId ?? "(unset — inferring from live markets)"}`);
    console.log(`signer    ${live.context.canTrade ? "LOADED — writes possible" : "none (read-only)"}`);
    console.log(`dry run   ${c.dryRun}`);
    console.log(`feed      ${c.priceFeed?.url ?? "NONE — no non-circular directional signal"}\n`);
  }

  try {
    const markets = await source.discover({ max: 8 });
    console.log(`Found ${markets.length} active event contract(s):\n`);

    for (const m of markets) {
      const book = await source.book(m);
      const under = await source.underlying(m.asset);
      const ref = await source.referencePrice(m);
      const left = secondsLeft(m);

      console.log(`  ${m.asset}  ${m.intervalSec}s window — "${m.question}"`);
      console.log(`    marketId   ${m.marketId}`);
      console.log(
        `    reference  ${ref ? `${ref.price} (${ref.source})` : "UNRESOLVED — directional claims will be unfounded"}`,
      );
      console.log(`    expires    in ${left}s ${hasHeadroom(m) ? "(enough headroom to convene)" : "(TOO LATE — skip)"}`);
      console.log(`    YES book   bid ${pct(book.bestYesBid)}  ask ${pct(book.bestYesAsk)}  mid ${pct(book.yesMid)}`);

      if (!useFixtures) {
        // The indexer said this market is active. Ask the chain.
        const chainStatus = await source.refreshStatus(m.marketId);
        const agrees = chainStatus === 1;
        console.log(`    on-chain   status ${chainStatus} ${agrees ? "(Trading)" : "(NOT tradable — indexer is stale)"}`);
      }

      const signals = extractSignals(m, book, under, ref);
      const independent = signals.filter((s) => !isCircular(s));
      console.log(`    evidence   ${signals.length} signals — ${independent.length} independent, ${signals.length - independent.length} circular`);
      for (const s of signals) {
        const tag = isCircular(s) ? "circular " : "independent";
        console.log(`               [${tag}] ${s.label}: ${s.value}${s.unit ?? ""}${s.staleness ? `  (${s.staleness}s old)` : ""}`);
      }
      console.log("");
    }

    if (has("--record")) {
      const path = val("--record") ?? "fixtures.json";
      const n = await FixtureMarketSource.record(source, path);
      console.log(`Recorded ${n} market(s) to ${path}`);
    }

    // The health check that actually matters: without an independent signal the
    // council can only restate the book, and every directional claim it makes
    // will be circular. Better to know now than on stage.
    const first = markets[0];
    if (first) {
      const under = await source.underlying(first.asset);
      if (!under) {
        console.log("WARNING  No underlying price feed. Every directional argument the");
        console.log("         council makes will be circular and Forensics will (correctly)");
        console.log("         reject it. Set PRICE_FEED_URL, or run with --fixtures.");
      }
    }
  } finally {
    await source.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(`\nFAILED  ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
