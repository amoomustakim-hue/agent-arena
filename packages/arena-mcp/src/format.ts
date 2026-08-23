/**
 * Rendering for LLM consumption.
 *
 * These tools are read by models, not by code, so the output is prose-shaped
 * text rather than a JSON dump. Two rules drive every renderer here:
 *
 *   - Units and provenance travel WITH the number. A bare `-7.08` invites the
 *     reader to guess a unit and a sign convention; `-7.08 bps below the window
 *     open` cannot be misread.
 *
 *   - Circular signals are labelled at the point of use, every time. A caller
 *     who reads only one tool's output must still be told that the book price
 *     is the market's own probability estimate and cannot justify disagreeing
 *     with it. Saying it once in a header would be missed.
 */

import type { Signal } from "@arena/core";
import type { ArenaMarket, Book, Reference, Underlying } from "@arena/market";
import { isCircular, secondsLeft, hasHeadroom } from "@arena/market";

export const pct = (n?: number) => (n === undefined ? "n/a" : `${(n * 100).toFixed(1)}%`);

export function duration(sec: number): string {
  if (sec < 0) return `expired ${-sec}s ago`;
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

export function marketLine(m: ArenaMarket): string {
  const left = secondsLeft(m);
  return [
    `${m.marketId}`,
    `  ${m.asset} · ${duration(m.intervalSec)} window · "${m.question}"`,
    `  expires in ${duration(left)}${hasHeadroom(m) ? "" : "  [TOO LATE — not enough window left to deliberate]"}`,
  ].join("\n");
}

export function marketDetail(
  m: ArenaMarket,
  book: Book,
  ref: Reference | undefined,
  chainStatus: number,
): string {
  const left = secondsLeft(m);
  const elapsed = (100 * (1 - left / m.intervalSec)).toFixed(1);
  const statusName =
    ["Listed", "Trading", "Locked", "Settling", "Resolved", "Voided"][chainStatus] ?? "Unknown";

  return [
    `Market ${m.marketId}`,
    `Contract:   ${m.question}`,
    `Asset:      ${m.asset}`,
    `Window:     ${duration(m.intervalSec)} — opened ${new Date(m.tradingStart * 1000).toISOString()}, expires ${new Date(m.expiry * 1000).toISOString()}`,
    `Time left:  ${duration(left)} (${elapsed}% of the window elapsed)`,
    ``,
    `Settlement reference:`,
    ref
      ? ref.source === "window_open"
        ? `  ${ref.price} — the ${m.asset} price when this window OPENED.\n` +
          `  This is a RELATIVE contract: YES settles true if ${m.asset} closes at or above that price.\n` +
          `  (The market row reports strike 0; that is a sentinel, not a real strike.)`
        : `  ${ref.price} — fixed strike. YES settles true if ${m.asset} closes at or above it.`
      : `  UNRESOLVED. The settlement reference could not be established, so "above" and\n` +
        `  "below" have no referent here. Any directional claim is unfounded.`,
    ``,
    `On-chain status: ${chainStatus} (${statusName})${chainStatus === 1 ? "" : " — NOT accepting orders"}`,
    `  Read from chain, not the indexer. The indexer lags by seconds.`,
    ``,
    `Order book (YES):`,
    `  bid ${pct(book.bestYesBid)}  ask ${pct(book.bestYesAsk)}  mid ${pct(book.yesMid)}`,
    `  The mid IS the market-implied probability of YES. It is CIRCULAR as a`,
    `  directional signal — see implied_probability.`,
  ].join("\n");
}

export function signalTable(signals: Signal[]): string {
  const independent = signals.filter((s) => !isCircular(s));
  const circular = signals.filter(isCircular);

  const row = (s: Signal) =>
    `  ${s.id.padEnd(20)} ${s.label}: ${s.value}${s.unit ?? ""}` +
    (s.staleness ? `   [${s.staleness}s old]` : "") +
    `\n${" ".repeat(24)}source: ${s.source}`;

  return [
    `INDEPENDENT EVIDENCE (${independent.length}) — can support a directional claim`,
    independent.length ? independent.map(row).join("\n") : "  (none)",
    ``,
    `CIRCULAR EVIDENCE (${circular.length}) — the contract's OWN price and things derived`,
    `from it. The book price already IS the market's probability estimate, so citing`,
    `it as grounds to disagree with the market is question-begging. Use these to`,
    `describe what the market thinks, or to judge liquidity — never as a reason.`,
    circular.length ? circular.map(row).join("\n") : "  (none)",
    ``,
    independent.length === 0
      ? `WARNING: there is NO independent evidence available. Any directional view here\n` +
        `would rest entirely on the contract's own price. The honest answer is a\n` +
        `probability near the market's, with low confidence.`
      : `Cite signals by id. auditCitations will reject ids that were never captured.`,
  ].join("\n");
}

export function underlyingLine(u: Underlying | undefined, asset: string): string {
  if (!u) {
    return (
      `No underlying price available for ${asset}.\n` +
      `Without it there is no non-circular directional signal — the only other\n` +
      `price in play is the contract's own, which is a probability.`
    );
  }
  const age = Math.max(0, Math.floor(Date.now() / 1000) - u.observedAt);
  return [
    `${asset} spot: ${u.spot}`,
    u.mark !== undefined ? `${asset} EMA mark: ${u.mark}` : null,
    `Observed ${age}s ago (feed timestamp, not read time).`,
    age > 30 ? `STALE: older than 30s. On a short window this describes a market that has moved.` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
