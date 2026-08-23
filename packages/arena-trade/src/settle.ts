/**
 * Settlement and scoring — where a prediction becomes a track record.
 *
 * This is the half of the product most demos skip, and the reason short windows
 * are an asset rather than a constraint: a 15-minute contract opened at the
 * start of a pitch has settled before the end of it. Predict, trade, settle,
 * score, replay — the whole loop, on stage, with real outcomes.
 *
 * Two rules keep the numbers honest:
 *
 *   - A market that has not resolved scores NOBODY. An unsettled forecast is
 *     not a result, and scoring it against a guess would inflate every figure
 *     downstream of it.
 *   - A VOIDED market scores nobody either. The agents were not wrong; the
 *     question was withdrawn.
 */

import {
  redeemOutcome,
  claimableOutcomes,
  estimatePayout,
  assertTxOk,
  type EcContext,
  type MarketOnchain,
} from "@dreamdex-bot-kit/ec-core";
import {
  brier,
  revisionQuality,
  type BlackBox,
  type AgentRole,
  type EventId,
} from "@arena/core";
import { marketStub, onchainOf } from "./venue.js";

export type Outcome = "YES" | "NO" | "VOID";

/**
 * Read the settled outcome from chain.
 *
 * Returns null while the market is still open — the caller must distinguish
 * "not yet" from "resolved NO", which a boolean cannot do. Outcome index 0 is
 * YES, 1 is NO (the same convention as `outcomeSymbols`).
 */
export function outcomeOf(onchain: MarketOnchain): Outcome | null {
  if (onchain.isVoided) return "VOID";
  if (!onchain.isResolved && !onchain.finalized) return null;
  return onchain.winningOutcome === 0 ? "YES" : "NO";
}

export interface ScoreRow {
  agent: AgentRole;
  /** Final probability, after revisions. */
  p: number;
  /** Opening probability, before any challenge. */
  p0: number;
  brier: number;
  brierOpening: number;
  correct: boolean;
  revisions: number;
  revisionsHelpful: number;
}

/**
 * Score every agent that stated a belief, and record it to the Black Box.
 *
 * Scoring reads the log rather than any in-memory state, so a session reloaded
 * from disk scores identically to one still running. That is what makes the
 * track record reproducible: the evidence and the score come from the same
 * artefact.
 */
export function scoreSession(bb: BlackBox, outcome: Outcome, causedBy: EventId[] = []): ScoreRow[] {
  if (outcome === "VOID") return [];

  const openings = new Map<AgentRole, number>();
  const finals = new Map<AgentRole, number>();
  for (const e of bb.all()) {
    if (e.kind === "belief_stated") {
      if (!openings.has(e.belief.agent)) openings.set(e.belief.agent, e.belief.p);
      finals.set(e.belief.agent, e.belief.p);
    } else if (e.kind === "belief_revised") {
      finals.set(e.belief.agent, e.belief.p);
    }
  }

  const rows: ScoreRow[] = [];
  for (const [agent, p] of finals) {
    const p0 = openings.get(agent) ?? p;
    const rq = revisionQuality(bb, agent, outcome);
    const row: ScoreRow = {
      agent,
      p,
      p0,
      brier: brier(p, outcome),
      brierOpening: brier(p0, outcome),
      correct: p > 0.5 === (outcome === "YES"),
      revisions: rq.revisions,
      revisionsHelpful: rq.helpful,
    };
    rows.push(row);
    bb.record(
      {
        kind: "scored",
        agent,
        p,
        brier: row.brier,
        correct: row.correct,
        revisions: row.revisions,
        revisionsHelpful: row.revisionsHelpful,
      },
      causedBy,
    );
  }
  return rows;
}

export interface SettleResult {
  outcome: Outcome | null;
  scores: ScoreRow[];
  claimed: { outcome: "YES" | "NO"; shares: number; payout: number; hash?: string }[];
  notes: string[];
}

/**
 * Settle one session: resolve the outcome, score the council, and redeem any
 * winnings.
 *
 * Winnings are CLAIMED, not received. A settled position sits unredeemed until
 * something asks for it, which is the most common way a working bot quietly
 * leaves money on the table.
 */
export async function settle(
  ctx: EcContext,
  bb: BlackBox,
  opts: { symbol?: string; claim?: boolean } = {},
): Promise<SettleResult> {
  const notes: string[] = [];
  const onchain = await onchainOf(ctx, bb.marketId);
  const outcome = outcomeOf(onchain);

  if (outcome === null) {
    return {
      outcome: null,
      scores: [],
      claimed: [],
      notes: [`Market ${bb.marketId} has not resolved yet (status ${onchain.status}). Nobody is scored.`],
    };
  }

  const settledId = bb.record({
    kind: "settled",
    outcome,
    ...(outcome !== "VOID" ? { settlementPrice: Number(onchain.winningOutcome) } : {}),
  });

  const scores = scoreSession(bb, outcome, [settledId]);
  if (outcome === "VOID") notes.push("Market was VOIDED — the question was withdrawn, so nobody is scored.");

  const claimed: SettleResult["claimed"] = [];
  if (opts.claim && outcome !== "VOID") {
    if (!ctx.canTrade) {
      notes.push("Winnings not claimed: no signer loaded. Redemption is a write.");
    } else if (ctx.config.dryRun) {
      notes.push("Winnings not claimed: DRY_RUN is on. Redemption is a write.");
    } else {
      const market = marketStub(bb.marketId, opts.symbol ?? bb.marketId);
      try {
        for (const leg of await claimableOutcomes(ctx, market, onchain)) {
          const payout = await estimatePayout(ctx, market, onchain, leg.outcome, leg.shares);
          const res = await redeemOutcome(ctx, market, onchain, leg.outcome);
          assertTxOk(res as any, `redeem ${leg.outcome}`);
          claimed.push({
            outcome: leg.outcome,
            shares: leg.shares,
            payout: Number(payout),
            ...((res as any)?.hash ? { hash: (res as any).hash } : {}),
          });
        }
        if (!claimed.length) notes.push("Nothing to claim — no winning shares held on this market.");
      } catch (e) {
        notes.push(`Claim failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  return { outcome, scores, claimed, notes };
}

/** Did the debate move this council toward the truth? Computed per session so
 *  a single run can show it, rather than waiting for a corpus. */
export function debateEffect(scores: ScoreRow[]): { opening: number; final: number; delta: number } {
  if (!scores.length) return { opening: 0, final: 0, delta: 0 };
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const opening = mean(scores.map((s) => s.brierOpening));
  const final = mean(scores.map((s) => s.brier));
  return { opening, final, delta: opening - final };
}
