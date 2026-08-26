/**
 * A synthetic corpus for demoing the leaderboard before real sessions exist.
 *
 * Deliberately gives each persona a DIFFERENT pathology, because a leaderboard
 * where everyone looks good demonstrates nothing. The bull is over-confident,
 * the judge is well calibrated but barely moves off the market, forensics has
 * genuine edge, and the bear hugs the base rate. Clearly labelled as synthetic
 * everywhere it is used — it exists to exercise the scoring, not to inflate it.
 *
 * Exported (not CLI-private) so the web UI's reputation page and the CLI show
 * the exact same demo data rather than two hand-tuned corpora quietly drifting
 * apart.
 */

import type { AgentRole } from "@arena/core";
import { brier, type Record_ } from "./scoring.js";

export function demoRecords(n = 120): Record_[] {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const roles: AgentRole[] = ["bull", "bear", "forensics", "judge"];
  const out: Record_[] = [];

  for (let i = 0; i < n; i++) {
    const marketP = 0.25 + rnd() * 0.5;
    const truth = rnd() < marketP ? "YES" : "NO";
    for (const agent of roles) {
      let p: number;
      switch (agent) {
        case "bull": // pushes toward YES and overstates confidence
          p = Math.min(0.97, marketP + 0.12 + rnd() * 0.1);
          break;
        case "bear": // hugs the base rate — reliable, no resolution
          p = 0.45 + (rnd() - 0.5) * 0.06;
          break;
        case "forensics": // small genuine edge toward the truth
          p = marketP + (truth === "YES" ? 0.06 : -0.06) + (rnd() - 0.5) * 0.08;
          break;
        default: // judge: calibrated, close to the market
          p = marketP + (rnd() - 0.5) * 0.05;
      }
      p = Math.max(0.02, Math.min(0.98, p));
      const p0 = Math.max(0.02, Math.min(0.98, p + (rnd() - 0.5) * 0.14));
      const revised = rnd() < 0.4;
      out.push({
        sessionId: `demo-${i}`,
        marketId: `0xdemo${i}`,
        agent,
        asset: i % 2 ? "BTC" : "ETH",
        intervalSec: [900, 3600, 14400][i % 3]!,
        p,
        p0: revised ? p0 : p,
        marketP,
        outcome: truth,
        revisions: revised ? 1 : 0,
        revisionsHelpful: revised && brier(p, truth) < brier(p0, truth) ? 1 : 0,
        settledAt: Date.now() - i * 900_000,
      });
    }
  }
  return out;
}
