/**
 * Server-only data access for the reputation pages. Reads the shared
 * `blackbox/` session directory directly — the same JSONL files the Python
 * backend writes and the TS reputation CLI already reads — rather than going
 * through an HTTP round-trip. The war room page reads Black Box files the
 * same way; this keeps that one pattern rather than introducing a second one
 * just for reputation data.
 */

import { join } from "node:path";
import { allRecords, leaderboard, statsFor, demoRecords, type Record_, type AgentStats } from "@arena/reputation";
export type { Record_, AgentStats };

const SESSIONS_DIR = join(process.cwd(), "..", "..", "blackbox");

export interface ReputationData {
  records: Record_[];
  isDemo: boolean;
}

export async function loadReputation(): Promise<ReputationData> {
  const real = await allRecords(SESSIONS_DIR).catch(() => []);
  if (real.length) return { records: real, isDemo: false };
  // No settled real sessions yet (no council has finished an LLM run in this
  // environment) — fall back to the same synthetic corpus the CLI's --demo
  // flag uses, clearly labelled, so the page has something honest to show
  // rather than an empty screen.
  return { records: demoRecords(), isDemo: true };
}

export { leaderboard, statsFor };
