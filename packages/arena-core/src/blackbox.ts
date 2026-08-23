/**
 * The Prediction Black Box (vision doc §3).
 *
 * One append-only, causally-linked event log per market. This is the single
 * source of truth for the whole product: the live UI renders a projection of
 * it, replay re-renders it at an earlier `seq`, calibration scores it after
 * settlement, and counterfactual replay deletes a node and recomputes.
 *
 * Two properties make all of that work, and both are easy to lose:
 *
 *   1. APPEND-ONLY. Nothing is ever mutated. A revised belief is a NEW event
 *      that points back at the one it supersedes. If you mutate a belief in
 *      place you can still show the final number, but you have destroyed the
 *      §5 belief timeline — the actual product.
 *
 *   2. EXPLICIT CAUSALITY. Every event names the events that caused it, in
 *      `causedBy`. Without this you have a chronology, not a flight recorder:
 *      you can show that a probability moved at 14:03 but not WHY, and "which
 *      evidence caused the change" (§3) becomes unanswerable.
 *
 * Timestamps are wall-clock for display only. Ordering is by `seq`, which is
 * monotonic per recorder — agents run concurrently and their wall clocks
 * interleave unhelpfully.
 */

/** Stable id for one event within a session: `${sessionId}:${seq}`. */
export type EventId = string;

export type AgentRole =
  | "bull"
  | "bear"
  | "forensics"
  | "adversarial"
  | "judge"
  | "trader"
  | "risk";

/**
 * Where a piece of evidence came from, and — critically — whether it is
 * independent of the contract being priced.
 *
 * `derived` means the signal was computed FROM the event contract's own book.
 * Those are legitimate as a read of what the market believes, but they are
 * circular as a directional signal: the contract's price is a probability, so
 * "the price went up, therefore it will go up" is question-begging. The kit
 * warns about exactly this (ec-core/config.ts on `priceFeed`). Forensics keys
 * off this field, so it is not decoration.
 */
export type SignalOrigin =
  | "underlying" // the BTC/ETH spot + EMA mark. Independent. The real signal.
  | "book" // this contract's own orderbook. Circular for direction.
  | "derived" // computed from `book` values. Circular, transitively.
  | "chain" // on-chain state read directly. Independent, authoritative.
  | "clock"; // time to expiry. Independent and exact.

export interface Signal {
  id: string;
  label: string;
  value: number | string;
  unit?: string;
  origin: SignalOrigin;
  /** When the underlying datum was produced — NOT when we read it. The indexer
   *  lags the chain by seconds, so these differ and the gap is the story. */
  observedAt: number;
  /** Seconds between `observedAt` and the read. Forensics flags stale reads. */
  staleness?: number;
  source: string;
}

/** A probability in (0,1). Never 0 or 1 — a settled market is not a belief. */
export type Probability = number;

export interface BeliefBody {
  agent: AgentRole;
  p: Probability;
  confidence: number;
  rationale: string;
  /** Signal ids this belief actually rests on. An empty list is itself a
   *  finding: an agent asserting a probability from nothing. */
  cites: string[];
}

export type BlackBoxEvent =
  /** A market snapshot. The generation to act on for this pass. */
  | { kind: "market_observed"; marketId: string; symbol: string; strike: number; expiry: number; intervalSec: number; status: number; yesMid?: number; yesBid?: number; yesAsk?: number }
  /** Evidence entered the record. */
  | { kind: "signal_captured"; signal: Signal }
  /** An agent's opening position. */
  | { kind: "belief_stated"; belief: BeliefBody }
  /** One agent attacks another's reasoning. `severity` drives the UI weight. */
  | { kind: "challenge_issued"; from: AgentRole; against: AgentRole; claim: string; severity: "minor" | "material" | "fatal"; targets: EventId }
  /**
   * The event the entire product exists to capture (§5). An agent moved, and
   * `causedBy` says what moved it. `supersedes` chains the timeline.
   */
  | { kind: "belief_revised"; belief: BeliefBody; from: Probability; supersedes: EventId }
  /** An agent was challenged and did not move. Also informative — held ground. */
  | { kind: "belief_held"; agent: AgentRole; p: Probability; because: string }
  | { kind: "verdict"; p: Probability; dissent: string; spread: number }
  | { kind: "edge_computed"; marketImplied: Probability; councilP: Probability; edge: number }
  | { kind: "trade_proposed"; side: "YES" | "NO"; limitPrice: number; size: number; maxLoss: number; invalidation: string }
  | { kind: "risk_verdict"; ok: boolean; concerns: string[] }
  /** The §14 approval gate. `actor` is always a human. */
  | { kind: "trade_approved"; actor: string }
  | { kind: "trade_rejected"; actor: string; why: string }
  | { kind: "trade_executed"; txHash: string; dryRun: boolean; filled: number }
  | { kind: "settled"; outcome: "YES" | "NO" | "VOID"; settlementPrice?: number }
  /** Post-settlement scoring. Brier is the calibration metric (§8). */
  | { kind: "scored"; agent: AgentRole; p: Probability; brier: number; correct: boolean; revisions: number; revisionsHelpful: number };

/** An event as recorded: the body plus its position and causal parents. */
export type RecordedEvent = BlackBoxEvent & {
  id: EventId;
  seq: number;
  ts: number;
  /** Ids of the events that caused this one. The replay graph's edges. */
  causedBy: EventId[];
};

/**
 * Append-only recorder. Deliberately dumb: no querying, no indexes, no
 * mutation. Projections (below) do the interpreting, so a projection bug can
 * never corrupt the record it reads.
 */
export class BlackBox {
  readonly sessionId: string;
  readonly marketId: string;
  private readonly events: RecordedEvent[] = [];
  private readonly listeners = new Set<(e: RecordedEvent) => void>();

  constructor(sessionId: string, marketId: string) {
    this.sessionId = sessionId;
    this.marketId = marketId;
  }

  /** Append one event. Returns its id so callers can cite it in `causedBy`. */
  record(event: BlackBoxEvent, causedBy: EventId[] = []): EventId {
    const seq = this.events.length;
    const rec: RecordedEvent = {
      ...event,
      id: `${this.sessionId}:${seq}`,
      seq,
      ts: Date.now(),
      causedBy,
    };
    this.events.push(rec);
    for (const l of this.listeners) l(rec);
    return rec.id;
  }

  /** Live tail, for the war-room UI (§13). Returns an unsubscribe. */
  subscribe(fn: (e: RecordedEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  all(): readonly RecordedEvent[] {
    return this.events;
  }

  /** The record as it stood at `seq` — this is replay (§3). */
  at(seq: number): RecordedEvent[] {
    return this.events.filter((e) => e.seq <= seq);
  }

  get(id: EventId): RecordedEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** JSONL, one event per line. Append-only on disk too, so a crashed session
   *  still replays up to the crash. */
  toJSONL(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n");
  }

  static fromJSONL(text: string, sessionId: string, marketId: string): BlackBox {
    const bb = new BlackBox(sessionId, marketId);
    for (const line of text.split("\n")) {
      if (line.trim()) (bb.events as RecordedEvent[]).push(JSON.parse(line));
    }
    return bb;
  }
}

// ---------------------------------------------------------------------------
// Projections — derived views. Never mutate the log.
// ---------------------------------------------------------------------------

export interface TimelinePoint {
  seq: number;
  ts: number;
  p: Probability;
  /** What moved it, resolved from `causedBy` into readable text. */
  because: string;
  eventId: EventId;
}

/**
 * One agent's probability over time (§5): 71% → 64% → 58% → 63%, with each
 * step annotated by its cause.
 */
export function beliefTimeline(bb: BlackBox, agent: AgentRole): TimelinePoint[] {
  const out: TimelinePoint[] = [];
  for (const e of bb.all()) {
    if (e.kind === "belief_stated" && e.belief.agent === agent) {
      out.push({ seq: e.seq, ts: e.ts, p: e.belief.p, because: "opening thesis", eventId: e.id });
    } else if (e.kind === "belief_revised" && e.belief.agent === agent) {
      const causes = e.causedBy
        .map((id) => bb.get(id))
        .filter((c): c is RecordedEvent => !!c)
        .map(describe);
      out.push({
        seq: e.seq,
        ts: e.ts,
        p: e.belief.p,
        because: causes.length ? causes.join("; ") : e.belief.rationale,
        eventId: e.id,
      });
    }
  }
  return out;
}

/** A one-line human description of an event, for causal annotations. */
export function describe(e: RecordedEvent): string {
  switch (e.kind) {
    case "signal_captured":
      return `${e.signal.label} = ${e.signal.value}${e.signal.unit ?? ""} (${e.signal.origin})`;
    case "challenge_issued":
      return `${e.from} challenged ${e.against}: ${e.claim}`;
    case "belief_stated":
      return `${e.belief.agent} opened at ${(e.belief.p * 100).toFixed(0)}%`;
    case "belief_revised":
      return `${e.belief.agent} moved ${(e.from * 100).toFixed(0)}% → ${(e.belief.p * 100).toFixed(0)}%`;
    case "market_observed":
      return `market ${e.symbol} @ ${e.yesMid !== undefined ? (e.yesMid * 100).toFixed(0) + "%" : "no book"}`;
    default:
      return e.kind;
  }
}

/**
 * Counterfactual replay (§16): drop one event and everything causally
 * downstream of it, then report what survives.
 *
 * This answers "would the council have reached the same verdict without this
 * piece of evidence?" It is a structural answer, not a re-run: it shows which
 * conclusions DEPENDED on the removed node. Re-running the LLMs would be a
 * different (and non-deterministic) experiment.
 */
export function counterfactual(bb: BlackBox, removeId: EventId): {
  removed: EventId[];
  surviving: RecordedEvent[];
  verdictSurvives: boolean;
} {
  const dead = new Set<EventId>([removeId]);
  // Causality flows forward in seq order, so one pass suffices.
  for (const e of bb.all()) {
    if (e.causedBy.some((c) => dead.has(c))) dead.add(e.id);
  }
  const surviving = bb.all().filter((e) => !dead.has(e.id));
  return {
    removed: [...dead],
    surviving,
    verdictSurvives: surviving.some((e) => e.kind === "verdict"),
  };
}

/**
 * Brier score: (p - outcome)². Lower is better; 0.25 is a coin flip.
 *
 * Chosen over raw accuracy deliberately (§8). Accuracy rewards an agent that
 * says 51% and is right; Brier rewards an agent whose 70%s come true 70% of
 * the time. On a binary venue where the honest answer is often "close to even",
 * accuracy is nearly noise and calibration is the only real signal.
 */
export function brier(p: Probability, outcome: "YES" | "NO"): number {
  const actual = outcome === "YES" ? 1 : 0;
  return (p - actual) ** 2;
}

/**
 * Did an agent's revisions actually help? Counts revisions that moved toward
 * the truth versus away from it.
 *
 * This is the measurable form of "intellectual honesty" (§4). An agent that
 * changes its mind constantly is not thereby good; an agent whose changes move
 * it toward the outcome is. Scored only after settlement.
 */
export function revisionQuality(bb: BlackBox, agent: AgentRole, outcome: "YES" | "NO"): {
  revisions: number;
  helpful: number;
} {
  const tl = beliefTimeline(bb, agent);
  const target = outcome === "YES" ? 1 : 0;
  let helpful = 0;
  for (let i = 1; i < tl.length; i++) {
    const before = Math.abs(tl[i - 1]!.p - target);
    const after = Math.abs(tl[i]!.p - target);
    if (after < before) helpful++;
  }
  return { revisions: Math.max(0, tl.length - 1), helpful };
}
