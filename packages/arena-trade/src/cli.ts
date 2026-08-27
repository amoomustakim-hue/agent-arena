/**
 * The trade chain, end to end, against the live venue in dry-run.
 *
 *   pnpm run trade                        # propose → risk → approve → dry-run
 *   pnpm run trade -- --p 0.72            # stand-in council probability
 *   pnpm run trade -- --deny              # prove the approval gate blocks
 *   pnpm run trade -- --interactive       # real terminal approval prompt
 *   pnpm run trade -- --settle <marketId> # score a settled market
 *
 * This package does not own the council, so `--p` stands in for a verdict. That
 * is deliberate: the trade path must be testable without spending tokens, and a
 * risk check that only runs behind an LLM is a risk check that rarely runs.
 */

import { BlackBox } from "@arena/core";
import { LiveMarketSource } from "@arena/market/live.js";
import { hasHeadroom, secondsLeft } from "@arena/market";
import { venueGrid, venueFees, onchainOf } from "./venue.js";
import { propose, isProposal } from "./propose.js";
import { assess } from "./risk.js";
import { execute, renderPreview, denyAll, terminalGate, type ApprovalGate } from "./execute.js";
import { settle, debateEffect } from "./settle.js";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => {
  const i = argv.indexOf(f);
  return i === -1 ? undefined : argv[i + 1];
};
const num = (f: string, d: number) => {
  const v = val(f);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

const rule = (s: string) => console.log(`\n${"─".repeat(72)}\n${s}\n${"─".repeat(72)}`);

async function main() {
  const source = LiveMarketSource.create();
  const ctx = source.context;

  console.log(`network   ${ctx.config.network} (chain ${ctx.config.chainId})`);
  console.log(`signer    ${ctx.canTrade ? "LOADED" : "none (read-only)"}`);
  console.log(`DRY_RUN   ${ctx.config.dryRun}${ctx.config.dryRun ? "" : "   *** ARMED ***"}`);

  try {
    // ---- Settlement mode: score a market that has already resolved.
    const settleId = val("--settle");
    if (settleId) {
      const bb = new BlackBox(`settle-${Date.now()}`, settleId);
      const res = await settle(ctx, bb, { claim: has("--claim") });
      rule("SETTLEMENT");
      console.log(`outcome: ${res.outcome ?? "NOT YET RESOLVED"}`);
      for (const n of res.notes) console.log(`  ${n}`);
      for (const s of res.scores) {
        console.log(
          `  ${s.agent.padEnd(12)} p=${s.p.toFixed(2)} Brier ${s.brier.toFixed(4)} ` +
            `${s.correct ? "correct" : "wrong"}  (opened ${s.p0.toFixed(2)}, Brier ${s.brierOpening.toFixed(4)})`,
        );
      }
      if (res.scores.length) {
        const d = debateEffect(res.scores);
        console.log(`  debate: ${d.opening.toFixed(4)} → ${d.final.toFixed(4)} (${d.delta >= 0 ? "helped" : "HURT"})`);
      }
      return;
    }

    // ---- Pick a market with room to act.
    const markets = await source.discover({ max: 20 });
    const wanted = val("--market");
    // Rank by headroom RATIO, not absolute seconds. A 24h contract with 30
    // minutes left has more absolute time than a 15m contract that just opened,
    // but far less room relative to its own window — and the risk floor scales
    // to the window. Sorting on raw seconds picks the wrong one.
    const ratio = (m: (typeof markets)[number]) => secondsLeft(m) / m.intervalSec;
    // NOT `.filter(hasHeadroom)` — Array.filter passes (element, index, array),
    // and hasHeadroom's optional `fraction` param would silently receive the
    // array index instead of its 0.25 default for every element past index 0.
    const candidates = markets.filter((m) => hasHeadroom(m)).sort((a, b) => ratio(b) - ratio(a));
    if (has("--candidates")) {
      console.log(`\ncandidates (${candidates.length} of ${markets.length} have headroom):`);
      for (const m of markets) {
        console.log(
          `  ${m.asset.padEnd(4)} ${String(m.intervalSec).padStart(6)}s  ${String(secondsLeft(m)).padStart(7)}s left  ` +
            `${(ratio(m) * 100).toFixed(0).padStart(3)}% remaining  ${hasHeadroom(m) ? "" : "(no headroom)"}`,
        );
      }
    }
    const market = wanted ? markets.find((m) => m.marketId === wanted) : candidates[0];
    if (!market) {
      console.log(wanted ? `\nNo such market ${wanted}.` : `\nNo market has enough window left to act on.`);
      return;
    }

    const [book, reference] = await Promise.all([source.book(market), source.referencePrice(market)]);
    const onchain = await onchainOf(ctx, market.marketId);
    const grid = venueGrid(ctx);
    const fees = await venueFees(ctx, market.marketId, onchain);

    rule(`MARKET  ${market.asset} ${market.intervalSec}s — "${market.question}"`);
    console.log(`  ${market.marketId}`);
    console.log(`  reference   ${reference ? `${reference.price} (${reference.source})` : "UNRESOLVED"}`);
    console.log(`  time left   ${secondsLeft(market)}s`);
    console.log(`  YES book    bid ${book.bestYesBid ?? "—"}  ask ${book.bestYesAsk ?? "—"}  mid ${book.yesMid ?? "—"}`);
    console.log(`  fees        settlement ${fees.settlementBps}bps, taker ${fees.takerBps}bps  [${fees.source}]`);
    console.log(`  grid        tick ${grid.tickHuman}  lot ${grid.lotHuman}  decimals ${grid.decimals}`);

    // ---- Propose.
    const councilP = num("--p", Math.min(0.95, (book.yesMid ?? 0.5) + 0.08));
    rule(`PROPOSAL  (stand-in council probability: P(YES) = ${councilP.toFixed(3)})`);
    const result = propose({
      market,
      book,
      reference,
      councilP,
      grid,
      fees,
      budget: num("--budget", 5),
      minEv: num("--min-ev", 0.02),
      orderType: has("--post-only") ? "post-only" : "ioc",
    });

    if (!isProposal(result)) {
      console.log(`  NO TRADE — ${result.reason}\n`);
      console.log(`  ${result.detail}`);
      return;
    }
    console.log(`  ${result.outcome} @ ${result.limitPrice}  ×${result.size} shares`);
    console.log(`  EV/share    ${(result.evPerShare * 100).toFixed(2)}pp`);
    console.log(
      `  breakeven   ${(result.breakeven * 100).toFixed(1)}%` +
        (fees.settlementBps > 0
          ? `  (vs ${(result.limitPrice * 100).toFixed(1)}% price — the gap is the ${fees.settlementBps}bps settlement fee)`
          : `  (equals the price: settlement fee is 0bps on this venue)`),
    );
    console.log(`  max loss    ${result.maxLoss}`);
    console.log(`\n  ${result.reasoning}`);
    console.log(`\n  invalidated by: ${result.invalidation}`);

    // ---- Risk.
    const bb = new BlackBox(`trade-${Date.now()}`, market.marketId);
    const proposalId = bb.record({
      kind: "trade_proposed",
      side: result.outcome,
      limitPrice: result.limitPrice,
      size: result.size,
      maxLoss: result.maxLoss,
      invalidation: result.invalidation,
    });

    rule("RISK");
    const verdict = assess({ proposal: result, market, book, onchain, grid, maxPosition: num("--max-position", 25) });
    const riskId = bb.record({ kind: "risk_verdict", ok: verdict.ok, concerns: verdict.concerns }, [proposalId]);
    console.log(`  ${verdict.ok ? "PASS" : "BLOCKED"}`);
    for (const c of verdict.concerns) console.log(`  ✗ ${c}`);
    for (const w of verdict.warnings) console.log(`  ! ${w}`);
    if (!verdict.ok) {
      console.log(`\n  Risk blocked this proposal. No approval is requested for a trade that cannot be sent.`);
      return;
    }

    // ---- Approve + execute.
    const gate: ApprovalGate = has("--deny")
      ? denyAll
      : has("--interactive")
        ? terminalGate()
        : async (_p, view) => {
            console.log(`\n  [auto-approving for this demo — a real run uses --interactive]`);
            console.log(renderPreview(view));
            return true;
          };

    rule("APPROVAL GATE + EXECUTION");
    const exec = await execute({
      ctx,
      proposal: result,
      onchain,
      grid,
      symbol: market.symbol,
      approve: gate,
      blackbox: bb,
      causedBy: [riskId],
    });

    console.log(`\n  executed: ${exec.executed}   dryRun: ${exec.dryRun}`);
    if (exec.reason) console.log(`  ${exec.reason}`);
    if (exec.order) console.log(`  filled ${exec.order.filled} of ${exec.order.size} @ ${exec.order.price}  tx ${exec.order.hash ?? "—"}`);

    rule("BLACK BOX");
    for (const e of bb.all()) {
      console.log(`  #${e.seq} ${e.kind.padEnd(16)} ${e.causedBy.length ? `← ${e.causedBy.map((c) => `#${c.split(":")[1]}`).join(",")}` : ""}`);
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
