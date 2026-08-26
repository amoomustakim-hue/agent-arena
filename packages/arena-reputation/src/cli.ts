/**
 * The leaderboard (§6) and agent profiles (§8).
 *
 *   pnpm run leaderboard              # rank every agent across all sessions
 *   pnpm run leaderboard -- --demo    # synthesise a corpus and rank it
 *   pnpm run leaderboard -- --agent bull
 *   pnpm run leaderboard -- --lineage
 */

import { leaderboard, statsFor, debateValue, byHorizon, type Record_, type AgentStats } from "./scoring.js";
import { demoRecords } from "./demo.js";
import { allRecords, SESSIONS_DIR } from "./store.js";
import { loadRegistry, renderTree } from "./lineage.js";
import type { AgentRole } from "@arena/core";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
/** Undefined when the flag is absent. `indexOf` returns -1, and -1 + 1 is 0 —
 *  so the naive form silently reads the FIRST argument as the flag's value. */
const val = (f: string) => {
  const i = argv.indexOf(f);
  return i === -1 ? undefined : argv[i + 1];
};

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const sign = (n: number) => (n >= 0 ? `+${n.toFixed(3)}` : n.toFixed(3));

function skillLabel(s: number | null): string {
  if (s === null) return "n/a";
  if (s > 0.05) return `${sign(s)}  BEATS the market`;
  if (s > -0.05) return `${sign(s)}  matches the market`;
  return `${sign(s)}  LOSES to the market`;
}

function renderAgent(s: AgentStats): string {
  const lines = [
    ``,
    `${s.agent.toUpperCase()}  —  ${s.predictions} settled prediction(s)`,
    `  Brier            ${s.brier.toFixed(4)}   (0.25 = coin flip, lower is better)`,
    `  Skill vs market  ${skillLabel(s.skillVsMarket)}`,
    `  Accuracy         ${pct(s.accuracy)}   (reported, not ranked on — see scoring.ts)`,
  ];

  if (s.revisions > 0) {
    lines.push(
      `  Revisions        ${s.revisions}, of which ${s.revisionsHelpful} moved toward the truth` +
        ` (${pct(s.revisionQuality ?? 0)})`,
      `  Debate effect    opening Brier ${s.brierOpening.toFixed(4)} → final ${s.brier.toFixed(4)}` +
        `  (${s.brierOpening > s.brier ? "debate HELPED" : "debate HURT"})`,
    );
  } else {
    lines.push(`  Revisions        none — never changed its mind under challenge`);
  }

  if (s.decomposition) {
    const d = s.decomposition;
    lines.push(
      ``,
      `  Brier decomposition (reliability - resolution + uncertainty):`,
      `    reliability   ${d.reliability.toFixed(4)}   miscalibration, lower is better`,
      `    resolution    ${d.resolution.toFixed(4)}   discrimination, HIGHER is better`,
      `    uncertainty   ${d.uncertainty.toFixed(4)}   the market's own variance, not the agent's doing`,
      d.resolution < 0.01
        ? `    → Near-zero resolution: this agent hugs the base rate. Rarely wrong, rarely useful.`
        : ``,
    );
  }

  if (s.calibration.length) {
    lines.push(``, `  Calibration (predicted → actual):`);
    for (const b of s.calibration) {
      const gap = b.actual - b.predicted;
      const flag = Math.abs(gap) > 0.15 ? (gap > 0 ? "  under-confident" : "  OVER-confident") : "";
      lines.push(
        `    ${pct(b.predicted).padStart(6)} → ${pct(b.actual).padStart(6)}   n=${String(b.count).padEnd(3)}${flag}`,
      );
    }
  }
  return lines.filter((l) => l !== "").join("\n");
}

async function main() {
  if (has("--lineage")) {
    const reg = await loadRegistry();
    console.log(reg.agents.length ? renderTree(reg) : "No agents registered yet.");
    return;
  }

  const demo = has("--demo");
  const records = demo ? demoRecords() : await allRecords();

  if (!records.length) {
    console.log(
      `No settled sessions in ${SESSIONS_DIR}/.\n\n` +
        `Reputation is built from SETTLED predictions only — an unsettled forecast is\n` +
        `not a result. Run councils and let their markets expire, or use --demo to\n` +
        `exercise the scoring against a synthetic corpus.`,
    );
    return;
  }

  if (demo) {
    console.log(`${"!".repeat(70)}\nSYNTHETIC CORPUS — demo data, not real predictions.\n${"!".repeat(70)}`);
  }

  const one = val("--agent") as AgentRole | undefined;
  if (one) {
    console.log(renderAgent(statsFor(one, records)));
    return;
  }

  const board = leaderboard(records);
  console.log(`\nLEADERBOARD  —  ${records.length} settled predictions across ${new Set(records.map((r) => r.sessionId)).size} sessions`);
  console.log(`Ranked by skill against the market. Beating the market is the only test that counts.\n`);
  console.log(`  ${"agent".padEnd(12)} ${"n".padEnd(5)} ${"Brier".padEnd(9)} skill vs market`);
  console.log(`  ${"-".repeat(12)} ${"-".repeat(5)} ${"-".repeat(9)} ${"-".repeat(30)}`);
  for (const s of board) {
    console.log(
      `  ${s.agent.padEnd(12)} ${String(s.predictions).padEnd(5)} ${s.brier.toFixed(4).padEnd(9)} ${skillLabel(s.skillVsMarket)}`,
    );
  }

  const dv = debateValue(records);
  console.log(
    [
      ``,
      `DID THE DEBATE HELP?`,
      `  opening Brier ${dv.openingBrier.toFixed(4)} → final ${dv.finalBrier.toFixed(4)}` +
        `   (${dv.improvement >= 0 ? "improved" : "WORSENED"} by ${Math.abs(dv.improvement).toFixed(4)})`,
      `  ${dv.revised} of ${records.length} predictions were revised under challenge.`,
      dv.improvement < 0
        ? `  The adversarial round is currently making predictions WORSE. That is a real`
        : `  Challenges are moving agents toward the truth on balance.`,
      dv.improvement < 0 ? `  finding, not a bug to hide — tune the personas or drop the round.` : ``,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  if (has("--horizons")) {
    console.log(`\nBY HORIZON  —  specialisation only shows up here`);
    for (const [k, board] of byHorizon(records)) {
      const best = board[0];
      if (best) console.log(`  ${k.padEnd(14)} best: ${best.agent} (Brier ${best.brier.toFixed(4)}, skill ${skillLabel(best.skillVsMarket)})`);
    }
  }

  console.log(`\nRun with --agent <role> for a full profile, or --horizons for per-window breakdown.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
