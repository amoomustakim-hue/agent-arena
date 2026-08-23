/**
 * Agent reputation — the measurement layer behind §6 and §8.
 *
 * The design decision that matters here is what "good" means. Accuracy is the
 * obvious metric and it is nearly worthless on this venue: these contracts
 * settle close to even most of the time, so an agent that says 51% and is right
 * scores identically to one that says 95% and is right, and a coin flip scores
 * ~50%. A leaderboard of accuracies would be a leaderboard of noise.
 *
 * So reputation rests on two things instead:
 *
 *   1. CALIBRATION — do an agent's 70%s come true 70% of the time? Measured by
 *      Brier score and its decomposition into reliability and resolution.
 *
 *   2. SKILL AGAINST THE MARKET — did the agent beat the price it was trading
 *      against? This is the only honest test on a prediction market. An agent
 *      with a 0.24 Brier looks good until you learn the market scored 0.21 on
 *      the same contracts, at which point the agent is destroying value.
 *
 * Most agents will fail (2). Reporting that plainly is the point: a track
 * record that cannot show failure is not a track record.
 */

import type { AgentRole, Probability } from "@arena/core";

/** One settled prediction — the atom of a track record. */
export interface Record_ {
  sessionId: string;
  marketId: string;
  agent: AgentRole;
  asset: string;
  /** Window length in seconds. Reputation is reported per horizon (§8). */
  intervalSec: number;
  /** The agent's FINAL probability, after any revisions. */
  p: Probability;
  /** The agent's opening probability, before challenges. */
  p0: Probability;
  /** What the market said at the moment the council convened. The baseline. */
  marketP: Probability;
  outcome: "YES" | "NO";
  revisions: number;
  revisionsHelpful: number;
  settledAt: number;
}

export const brier = (p: Probability, outcome: "YES" | "NO") =>
  (p - (outcome === "YES" ? 1 : 0)) ** 2;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Brier Skill Score against the market baseline.
 *
 *   BSS = 1 - (agent Brier / market Brier)
 *
 * Positive means the agent beat the market. Zero means it matched it. NEGATIVE
 * MEANS IT LOST TO SIMPLY TRADING AT THE MARKET PRICE — which is where most
 * agents will land, and the number that makes this leaderboard worth trusting.
 *
 * Returns null when the market baseline is degenerate (perfectly right every
 * time), because dividing by zero would report infinite skill for an agent that
 * merely tied.
 */
export function skillScore(records: Record_[]): number | null {
  if (!records.length) return null;
  const agentBrier = mean(records.map((r) => brier(r.p, r.outcome)));
  const marketBrier = mean(records.map((r) => brier(r.marketP, r.outcome)));
  if (marketBrier === 0) return null;
  return 1 - agentBrier / marketBrier;
}

export interface CalibrationBucket {
  /** Bucket midpoint, e.g. 0.65 for the 60–70% bucket. */
  predicted: number;
  /** How often YES actually happened in this bucket. */
  actual: number;
  count: number;
}

/**
 * The calibration curve: for each probability band, how often did YES occur?
 *
 * A perfectly calibrated agent traces the diagonal. Buckets with fewer than
 * `minCount` samples are dropped rather than shown, because a bucket holding
 * one prediction reads as either flawless or hopeless calibration and is
 * neither — it is one data point.
 */
export function calibration(records: Record_[], bins = 10, minCount = 3): CalibrationBucket[] {
  const buckets: Record_[][] = Array.from({ length: bins }, () => []);
  for (const r of records) {
    const i = Math.min(bins - 1, Math.floor(r.p * bins));
    buckets[i]!.push(r);
  }
  return buckets
    .map((rs, i) => ({
      predicted: (i + 0.5) / bins,
      actual: rs.length ? rs.filter((r) => r.outcome === "YES").length / rs.length : 0,
      count: rs.length,
    }))
    .filter((b) => b.count >= minCount);
}

/**
 * Murphy's decomposition of the Brier score:
 *
 *   Brier = reliability - resolution + uncertainty
 *
 * - `reliability`  — miscalibration. Lower is better; 0 is perfect.
 * - `resolution`   — how much the agent's predictions actually discriminate
 *                    between outcomes. HIGHER is better. An agent that always
 *                    says "50%" is perfectly reliable and has zero resolution:
 *                    never wrong, never useful.
 * - `uncertainty`  — the base rate's own variance. A property of the market,
 *                    not of the agent, and not something it can improve.
 *
 * Separating these is what distinguishes a genuinely sharp agent from a
 * cautious one hiding near the base rate — a distinction a single Brier number
 * cannot make.
 */
export function decompose(records: Record_[], bins = 10): {
  brier: number;
  reliability: number;
  resolution: number;
  uncertainty: number;
} | null {
  if (records.length < bins) return null;
  const n = records.length;
  const baseRate = records.filter((r) => r.outcome === "YES").length / n;
  const uncertainty = baseRate * (1 - baseRate);

  const buckets: Record_[][] = Array.from({ length: bins }, () => []);
  for (const r of records) buckets[Math.min(bins - 1, Math.floor(r.p * bins))]!.push(r);

  let reliability = 0;
  let resolution = 0;
  for (const rs of buckets) {
    if (!rs.length) continue;
    const forecast = mean(rs.map((r) => r.p));
    const observed = rs.filter((r) => r.outcome === "YES").length / rs.length;
    reliability += (rs.length / n) * (forecast - observed) ** 2;
    resolution += (rs.length / n) * (observed - baseRate) ** 2;
  }
  return {
    brier: mean(records.map((r) => brier(r.p, r.outcome))),
    reliability,
    resolution,
    uncertainty,
  };
}

export interface AgentStats {
  agent: AgentRole;
  predictions: number;
  brier: number;
  /** Brier of the agent's OPENING belief, before challenges. The gap between
   *  this and `brier` is the measurable value of the debate itself. */
  brierOpening: number;
  accuracy: number;
  skillVsMarket: number | null;
  revisions: number;
  revisionsHelpful: number;
  /** Of the revisions made, the share that moved toward the truth. Null when
   *  the agent never revised — 0/0 is "never tested", not "always wrong". */
  revisionQuality: number | null;
  calibration: CalibrationBucket[];
  decomposition: ReturnType<typeof decompose>;
}

export function statsFor(agent: AgentRole, records: Record_[]): AgentStats {
  const rs = records.filter((r) => r.agent === agent);
  const revisions = rs.reduce((a, r) => a + r.revisions, 0);
  const helpful = rs.reduce((a, r) => a + r.revisionsHelpful, 0);
  return {
    agent,
    predictions: rs.length,
    brier: mean(rs.map((r) => brier(r.p, r.outcome))),
    brierOpening: mean(rs.map((r) => brier(r.p0, r.outcome))),
    accuracy: rs.length
      ? rs.filter((r) => (r.p > 0.5 ? r.outcome === "YES" : r.outcome === "NO")).length / rs.length
      : 0,
    skillVsMarket: skillScore(rs),
    revisions,
    revisionsHelpful: helpful,
    revisionQuality: revisions > 0 ? helpful / revisions : null,
    calibration: calibration(rs),
    decomposition: decompose(rs),
  };
}

/**
 * Did the debate help?
 *
 * Compares every agent's opening Brier to its final Brier across the whole
 * corpus. If challenges do not on balance move agents toward the truth, the
 * adversarial round is expensive theatre and this number will say so.
 *
 * Worth running honestly and reporting whichever way it comes out — a debate
 * mechanism that cannot be shown to help is a claim, not a result.
 */
export function debateValue(records: Record_[]): {
  openingBrier: number;
  finalBrier: number;
  improvement: number;
  revised: number;
} {
  const openingBrier = mean(records.map((r) => brier(r.p0, r.outcome)));
  const finalBrier = mean(records.map((r) => brier(r.p, r.outcome)));
  return {
    openingBrier,
    finalBrier,
    improvement: openingBrier - finalBrier,
    revised: records.filter((r) => r.revisions > 0).length,
  };
}

/** Leaderboard, best first. Ranked by skill against the market where it can be
 *  computed, falling back to raw Brier — never by accuracy, for the reason in
 *  this file's header. */
export function leaderboard(records: Record_[]): AgentStats[] {
  const agents = [...new Set(records.map((r) => r.agent))];
  return agents
    .map((a) => statsFor(a, records))
    .sort((x, y) => {
      if (x.skillVsMarket !== null && y.skillVsMarket !== null) return y.skillVsMarket - x.skillVsMarket;
      return x.brier - y.brier;
    });
}

/** Slice a track record by market category and horizon (§8: "performance by
 *  market category and time horizon"). Specialisation only shows up here — an
 *  agent can be strong on 24h windows and useless on 15m ones. */
export function byHorizon(records: Record_[]): Map<string, AgentStats[]> {
  const out = new Map<string, AgentStats[]>();
  const key = (r: Record_) => `${r.asset} ${r.intervalSec}s`;
  for (const k of new Set(records.map(key))) {
    out.set(k, leaderboard(records.filter((r) => key(r) === k)));
  }
  return out;
}
