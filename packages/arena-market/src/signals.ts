/**
 * Turning market state into EVIDENCE.
 *
 * This is where the vision doc's "Evidence MCP" actually lives, and it is not
 * what the doc originally imagined. There is no news to verify on a five-minute
 * BTC contract and no sources to cross-reference. What there is, is a sharp and
 * genuinely adversarial distinction:
 *
 *   INDEPENDENT evidence — where BTC actually is, how far that is from the
 *   strike, how long is left. These can move a directional belief.
 *
 *   CIRCULAR evidence — the contract's own book. `yesMid` IS the market's
 *   probability estimate. Reasoning "the book says 68%, therefore YES is
 *   likely" is not analysis, it is restating the price. The kit warns about
 *   this explicitly (ec-core/config.ts on `priceFeed`).
 *
 * Every signal carries its `origin`, so Forensics can catch an agent that
 * builds a directional case out of circular inputs. That check is real, it is
 * specific to this venue, and it fires on genuine reasoning failures rather
 * than staged ones.
 */

import type { Signal } from "@arena/core/blackbox.js";
import type { ArenaMarket, Book, Reference, Underlying } from "./index.js";
import { secondsLeft } from "./index.js";

/** Origins that can legitimately support a DIRECTIONAL claim. */
const INDEPENDENT = new Set(["underlying", "chain", "clock"]);

export const isCircular = (s: Signal) => !INDEPENDENT.has(s.origin);

/**
 * Extract the evidence set for one market at one instant.
 *
 * Returns signals tagged with origin and staleness. Callers record these into
 * the Black Box before any agent speaks, so every belief can be checked against
 * what was actually available when it was formed.
 */
export function extractSignals(
  market: ArenaMarket,
  book: Book,
  under: Underlying | undefined,
  ref: Reference | undefined,
  now = Date.now(),
): Signal[] {
  const nowSec = Math.floor(now / 1000);
  const out: Signal[] = [];

  // --- Clock. Exact, independent, and the most underrated input on a short
  // window: at 20 seconds to expiry, distance-to-strike dominates everything.
  const left = secondsLeft(market, now);
  out.push({
    id: "time_left",
    label: "Seconds to expiry",
    value: left,
    unit: "s",
    origin: "clock",
    observedAt: nowSec,
    staleness: 0,
    source: "system clock",
  });
  out.push({
    id: "window_elapsed",
    label: "Window elapsed",
    value: +(100 * (1 - left / market.intervalSec)).toFixed(1),
    unit: "%",
    origin: "clock",
    observedAt: nowSec,
    staleness: 0,
    source: "system clock",
  });

  // --- The underlying. The only thing that can honestly justify a direction.
  if (under) {
    const staleness = nowSec - under.observedAt;
    out.push({
      id: "spot",
      label: `${market.asset} spot`,
      value: under.spot,
      origin: "underlying",
      observedAt: under.observedAt,
      staleness,
      source: "dreamDEX price feed",
    });

    // Distance to the reference in basis points — the single most
    // decision-relevant number on the board. Sign carries the direction:
    // positive = above the reference = currently settling YES.
    //
    // Guarded on `ref` deliberately. The live series carry strike 0, and
    // dividing by that yields Infinity — a number that looks like a signal,
    // reads as overwhelming conviction, and means nothing.
    if (ref && ref.price > 0) {
      const distBps = ((under.spot - ref.price) / ref.price) * 10_000;
      out.push({
        id: "strike_distance",
        label: ref.source === "window_open" ? "Distance from window open" : "Distance to strike",
        value: +distBps.toFixed(2),
        unit: "bps",
        origin: "underlying",
        observedAt: under.observedAt,
        staleness,
        source:
          ref.source === "window_open"
            ? `spot ${under.spot} vs window open ${ref.price}`
            : `spot ${under.spot} vs strike ${ref.price}`,
      });
      out.push({
        id: "reference_price",
        label: ref.source === "window_open" ? "Window open price" : "Strike",
        value: ref.price,
        origin: "underlying",
        observedAt: ref.observedAt,
        staleness: 0,
        source: ref.source === "window_open" ? "price-feed 1m candle at tradingStart" : "market row",
      });
    } else {
      out.push({
        id: "reference_unknown",
        label: "Settlement reference",
        value: "UNRESOLVED",
        origin: "underlying",
        observedAt: nowSec,
        staleness: 0,
        source: market.isRelative
          ? "relative contract; could not read the window's opening price"
          : "market row carries no usable strike",
      });
    }

    if (under.mark !== undefined) {
      // Spot vs EMA mark: short-horizon momentum, independent of the contract.
      const momentumBps = ((under.spot - under.mark) / under.mark) * 10_000;
      out.push({
        id: "momentum",
        label: "Spot vs EMA mark",
        value: +momentumBps.toFixed(2),
        unit: "bps",
        origin: "underlying",
        observedAt: under.observedAt,
        staleness,
        source: "dreamDEX price feed (EMA)",
      });
    }
  } else {
    // Absence is evidence. An agent must know it is flying blind rather than
    // silently substituting the book — which is exactly the circular trap.
    out.push({
      id: "spot_unavailable",
      label: "Underlying price feed",
      value: "UNAVAILABLE",
      origin: "underlying",
      observedAt: nowSec,
      staleness: 0,
      source: "no PRICE_FEED_URL configured",
    });
  }

  // --- The book. Recorded because the council must know what it is betting
  // against, and tagged `book`/`derived` so nobody mistakes it for a reason.
  if (book.yesMid !== undefined) {
    out.push({
      id: "market_implied",
      label: "Market-implied P(YES)",
      value: +(book.yesMid * 100).toFixed(1),
      unit: "%",
      origin: "book",
      observedAt: Math.floor(book.readAt / 1000),
      staleness: Math.max(0, nowSec - Math.floor(book.readAt / 1000)),
      source: "dreamDEX orderbook",
    });
  }
  if (book.bestYesBid !== undefined && book.bestYesAsk !== undefined) {
    const spread = book.bestYesAsk - book.bestYesBid;
    out.push({
      id: "spread",
      label: "YES bid-ask spread",
      value: +(spread * 100).toFixed(2),
      unit: "pp",
      origin: "derived",
      observedAt: Math.floor(book.readAt / 1000),
      staleness: Math.max(0, nowSec - Math.floor(book.readAt / 1000)),
      source: "derived from orderbook",
    });
    // Width gates sizing, not direction — a 15pp spread eats any edge the
    // council thinks it found. Risk reads this; Bull and Bear should not.
    out.push({
      id: "liquidity_quality",
      label: "Book quality",
      value: spread < 0.03 ? "tight" : spread < 0.10 ? "wide" : "illiquid",
      origin: "derived",
      observedAt: Math.floor(book.readAt / 1000),
      staleness: 0,
      source: "derived from spread",
    });
  } else {
    out.push({
      id: "book_empty",
      label: "Orderbook",
      value: "ONE-SIDED OR EMPTY",
      origin: "book",
      observedAt: nowSec,
      staleness: 0,
      source: "dreamDEX orderbook",
    });
  }

  return out;
}

export interface ForensicsFinding {
  severity: "minor" | "material" | "fatal";
  claim: string;
  signalIds: string[];
}

/**
 * Mechanical evidence checks — run BEFORE the Forensics LLM, so the obvious
 * failures are caught deterministically and for free.
 *
 * An LLM asked to police circular reasoning will miss it sometimes. This
 * cannot: `cites` is a list of ids, and origins are known. The Forensics agent
 * then reasons about what these findings MEAN, which is the part that needs a
 * model. Cheap checks first, expensive judgment second.
 */
export function auditCitations(
  cites: string[],
  signals: Signal[],
  opts: { directional: boolean; maxStaleness?: number } = { directional: true },
): ForensicsFinding[] {
  const byId = new Map(signals.map((s) => [s.id, s]));
  const cited = cites.map((id) => byId.get(id)).filter((s): s is Signal => !!s);
  const findings: ForensicsFinding[] = [];

  if (cites.length === 0) {
    findings.push({
      severity: "fatal",
      claim: "Stated a probability without citing any evidence.",
      signalIds: [],
    });
    return findings;
  }

  const unknown = cites.filter((id) => !byId.has(id));
  if (unknown.length) {
    findings.push({
      severity: "fatal",
      claim: `Cited evidence that was never captured: ${unknown.join(", ")}. This is fabrication, not inference.`,
      signalIds: unknown,
    });
  }

  if (opts.directional) {
    const independent = cited.filter((s) => INDEPENDENT.has(s.origin));
    const circular = cited.filter(isCircular);
    if (independent.length === 0 && circular.length > 0) {
      findings.push({
        severity: "fatal",
        claim:
          `Directional case rests entirely on the contract's own price (${circular
            .map((s) => s.id)
            .join(", ")}). The book IS the market's probability — citing it as a reason to ` +
          `disagree with the market is circular.`,
        signalIds: circular.map((s) => s.id),
      });
    }
  }

  const maxStale = opts.maxStaleness ?? 30;
  const stale = cited.filter((s) => (s.staleness ?? 0) > maxStale);
  if (stale.length) {
    findings.push({
      severity: "material",
      claim:
        `Relied on data older than ${maxStale}s (${stale
          .map((s) => `${s.id} @${s.staleness}s`)
          .join(", ")}). The indexer lags the chain; on a short window a stale read ` +
        `describes a market that no longer exists.`,
      signalIds: stale.map((s) => s.id),
    });
  }

  const blind = cited.find((s) => s.id === "spot_unavailable");
  if (blind && opts.directional) {
    findings.push({
      severity: "material",
      claim: "Argued direction with no underlying price feed available. There is no non-circular basis for a directional view here.",
      signalIds: ["spot_unavailable"],
    });
  }

  // Knowing where BTC is does not help if you do not know what it must beat.
  // On a relative contract an unresolved reference makes every directional
  // claim unfounded, however confidently it is phrased.
  if (opts.directional && cited.some((s) => s.id === "reference_unknown")) {
    findings.push({
      severity: "fatal",
      claim:
        "Argued direction without a settlement reference. This contract settles against its " +
        "window's opening price, which could not be resolved — so 'above' and 'below' have no " +
        "referent here.",
      signalIds: ["reference_unknown"],
    });
  }

  return findings;
}
