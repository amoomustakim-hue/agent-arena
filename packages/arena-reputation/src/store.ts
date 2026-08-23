/**
 * Persistence for completed council sessions, and extraction of track-record
 * rows from them.
 *
 * Sessions are stored as the Black Box's own JSONL — no separate schema, no
 * derived-state table. The event log IS the record; everything a profile page
 * shows is recomputed from it. That means a scoring bug is fixable by rerunning
 * the projection rather than by migrating a corrupted store, and an agent's
 * history can never disagree with the evidence it was built from.
 */

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BlackBox, type RecordedEvent, type AgentRole, revisionQuality } from "@arena/core";
import type { Record_ } from "./scoring.js";

export const SESSIONS_DIR = process.env.ARENA_SESSIONS ?? "blackbox";

export async function save(bb: BlackBox): Promise<string> {
  await mkdir(SESSIONS_DIR, { recursive: true });
  const path = join(SESSIONS_DIR, `${bb.sessionId}.jsonl`);
  await writeFile(path, bb.toJSONL(), "utf8");
  return path;
}

export async function loadAll(dir = SESSIONS_DIR): Promise<BlackBox[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return []; // no sessions yet is a normal state, not an error
  }
  const out: BlackBox[] = [];
  for (const f of files) {
    try {
      const text = await readFile(join(dir, f), "utf8");
      const sessionId = f.replace(/\.jsonl$/, "");
      const first = JSON.parse(text.split("\n")[0] ?? "{}");
      out.push(BlackBox.fromJSONL(text, sessionId, first.marketId ?? "unknown"));
    } catch {
      // A truncated session (crash mid-write) is skipped rather than fatal —
      // one bad file must not make an entire track record unreadable.
      continue;
    }
  }
  return out;
}

/**
 * Turn one settled session into per-agent track-record rows.
 *
 * Returns [] for a session that never settled. An unsettled prediction is not a
 * result, and quietly scoring it against a guessed outcome would inflate every
 * downstream number.
 */
export function extractRecords(bb: BlackBox): Record_[] {
  const events = bb.all();
  const settled = events.find((e) => e.kind === "settled");
  if (!settled || settled.kind !== "settled") return [];
  if (settled.outcome === "VOID") return []; // voided markets score nobody

  const market = events.find((e) => e.kind === "market_observed");
  if (!market || market.kind !== "market_observed") return [];

  // The market baseline must be the price at the time the council CONVENED,
  // not at settlement. Scoring against the settlement price would compare the
  // agent to a number nobody could have traded on.
  const edge = events.find((e) => e.kind === "edge_computed");
  const marketP =
    edge?.kind === "edge_computed" ? edge.marketImplied : market.yesMid ?? undefined;
  if (marketP === undefined) return [];

  const outcome = settled.outcome;
  const openings = new Map<AgentRole, number>();
  const finals = new Map<AgentRole, number>();

  for (const e of events) {
    if (e.kind === "belief_stated") {
      if (!openings.has(e.belief.agent)) openings.set(e.belief.agent, e.belief.p);
      finals.set(e.belief.agent, e.belief.p);
    } else if (e.kind === "belief_revised") {
      finals.set(e.belief.agent, e.belief.p);
    }
  }

  const rows: Record_[] = [];
  for (const [agent, p] of finals) {
    const rq = revisionQuality(bb, agent, outcome);
    rows.push({
      sessionId: bb.sessionId,
      marketId: bb.marketId,
      agent,
      asset: assetOf(market.symbol),
      intervalSec: market.intervalSec,
      p,
      p0: openings.get(agent) ?? p,
      marketP,
      outcome,
      revisions: rq.revisions,
      revisionsHelpful: rq.helpful,
      settledAt: settled.ts,
    });
  }
  return rows;
}

/** Symbols look like "BTC 15m @1787477400"; take the leading asset. */
const assetOf = (symbol: string) => symbol.split(/[\s-]/)[0] ?? "?";

export async function allRecords(dir = SESSIONS_DIR): Promise<Record_[]> {
  const sessions = await loadAll(dir);
  return sessions.flatMap(extractRecords);
}

/** Sessions still awaiting an outcome — what the replay UI shows as "pending",
 *  and what a settlement watcher should be checking. */
export async function pending(dir = SESSIONS_DIR): Promise<{ sessionId: string; marketId: string }[]> {
  const sessions = await loadAll(dir);
  return sessions
    .filter((bb) => !bb.all().some((e: RecordedEvent) => e.kind === "settled"))
    .map((bb) => ({ sessionId: bb.sessionId, marketId: bb.marketId }));
}
