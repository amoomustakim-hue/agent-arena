/**
 * Pure projections over one event array — the same operations `BlackBox`
 * itself exposes, reimplemented against a plain array rather than the class,
 * because the client component works from serialized props, not a live
 * instance. Kept here rather than duplicated across components.
 */

import type { RecordedEvent, EventId, AgentRole, Signal, BeliefBody } from "@arena/core/blackbox.js";

export const AGENTS: AgentRole[] = ["bull", "bear", "forensics", "adversarial", "risk", "judge"];

/** Every event with seq <= cutoff — replay at one instant (§3). */
export function eventsAt(all: RecordedEvent[], seq: number): RecordedEvent[] {
  return all.filter((e) => e.seq <= seq);
}

export function byId(all: RecordedEvent[]): Map<EventId, RecordedEvent> {
  return new Map(all.map((e) => [e.id, e]));
}

/** A one-line, human description of any event — used to label causal edges
 *  (belief timeline annotations, evidence panel "used by" links). */
export function describe(e: RecordedEvent): string {
  switch (e.kind) {
    case "market_observed":
      return `market observed — ${e.symbol}`;
    case "signal_captured":
      return `${e.signal.label}: ${e.signal.value}${e.signal.unit ?? ""}`;
    case "belief_stated":
      return `${e.belief.agent} opened at ${pct(e.belief.p)}`;
    case "belief_revised":
      return `${e.belief.agent} moved ${pct(e.from)} → ${pct(e.belief.p)}`;
    case "belief_held":
      return `${e.agent} held at ${pct(e.p)}`;
    case "challenge_issued":
      return `${e.from} challenged ${e.against} [${e.severity}]`;
    case "verdict":
      return `verdict — ${pct(e.p)}`;
    case "edge_computed":
      return `edge ${e.edge >= 0 ? "+" : ""}${(e.edge * 100).toFixed(1)}pp`;
    case "trade_proposed":
      return `proposed ${e.side} × ${e.size}`;
    case "risk_verdict":
      return e.ok ? "risk: pass" : "risk: blocked";
    case "trade_approved":
      return `approved by ${e.actor}`;
    case "trade_rejected":
      return `rejected — ${e.why}`;
    case "trade_executed":
      return e.dryRun ? "executed (dry run)" : `executed — ${e.filled} filled`;
    case "settled":
      return `settled ${e.outcome}`;
    case "scored":
      return `${e.agent} scored — brier ${e.brier.toFixed(4)}`;
  }
}

export interface TimelinePoint {
  seq: number;
  eventId: EventId;
  p: number;
  confidence: number;
  belief: BeliefBody;
  because: string;
  causedByIds: EventId[];
  kind: "opened" | "revised";
  from?: number;
}

/** One agent's probability across the whole session, each point annotated
 *  with what caused it — the §5 feature this entire product exists for. */
export function beliefTimeline(all: RecordedEvent[], agent: AgentRole): TimelinePoint[] {
  const idx = byId(all);
  const out: TimelinePoint[] = [];
  for (const e of all) {
    if (e.kind === "belief_stated" && e.belief.agent === agent) {
      out.push({
        seq: e.seq,
        eventId: e.id,
        p: e.belief.p,
        confidence: e.belief.confidence,
        belief: e.belief,
        because: "opening thesis",
        causedByIds: e.causedBy,
        kind: "opened",
      });
    } else if (e.kind === "belief_revised" && e.belief.agent === agent) {
      const causes = e.causedBy.map((id) => idx.get(id)).filter((x): x is RecordedEvent => !!x);
      out.push({
        seq: e.seq,
        eventId: e.id,
        p: e.belief.p,
        confidence: e.belief.confidence,
        belief: e.belief,
        because: causes.length ? causes.map(describe).join("; ") : e.belief.rationale,
        causedByIds: e.causedBy,
        kind: "revised",
        from: e.from,
      });
    }
  }
  return out;
}

/** The agent's CURRENT belief at a given seq — last stated/revised/held entry
 *  at or before that point. Powers the roster cards under the scrubber. */
export function currentBelief(
  all: RecordedEvent[],
  agent: AgentRole,
): { p: number; confidence?: number; rationale?: string; movedFrom?: number; heldAt?: boolean } | null {
  let out: ReturnType<typeof currentBelief> = null;
  for (const e of all) {
    if (e.kind === "belief_stated" && e.belief.agent === agent) {
      out = { p: e.belief.p, confidence: e.belief.confidence, rationale: e.belief.rationale };
    } else if (e.kind === "belief_revised" && e.belief.agent === agent) {
      out = { p: e.belief.p, confidence: e.belief.confidence, rationale: e.belief.rationale, movedFrom: e.from };
    } else if (e.kind === "belief_held" && e.agent === agent) {
      out = { p: e.p, rationale: e.because, heldAt: true };
    }
  }
  return out;
}

export function revisionCount(all: RecordedEvent[], agent: AgentRole): number {
  return all.filter((e) => e.kind === "belief_revised" && e.belief.agent === agent).length;
}

/** Counterfactual replay: drop one event and everything causally downstream
 *  of it. A structural answer to "would the verdict survive without this",
 *  not a re-run. */
export function counterfactual(
  all: RecordedEvent[],
  removeId: EventId,
): { dead: Set<EventId>; verdictSurvives: boolean } {
  const dead = new Set<EventId>([removeId]);
  for (const e of all) {
    if (e.causedBy.some((c) => dead.has(c))) dead.add(e.id);
  }
  return { dead, verdictSurvives: all.some((e) => e.kind === "verdict" && !dead.has(e.id)) };
}

export const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
export const pp = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}pp`;
export const bps = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}bps`;

export function findEvent<K extends RecordedEvent["kind"]>(
  all: RecordedEvent[],
  kind: K,
): Extract<RecordedEvent, { kind: K }> | undefined {
  return all.find((e): e is Extract<RecordedEvent, { kind: K }> => e.kind === kind);
}

export function findAllEvents<K extends RecordedEvent["kind"]>(
  all: RecordedEvent[],
  kind: K,
): Extract<RecordedEvent, { kind: K }>[] {
  return all.filter((e): e is Extract<RecordedEvent, { kind: K }> => e.kind === kind);
}

export function allSignals(all: RecordedEvent[]): { event: RecordedEvent; signal: Signal }[] {
  return findAllEvents(all, "signal_captured").map((e) => ({ event: e, signal: e.signal }));
}

export const isCircular = (s: Signal) => s.origin === "book" || s.origin === "derived";
