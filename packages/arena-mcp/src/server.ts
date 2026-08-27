#!/usr/bin/env node
/**
 * Agent Arena — Market Intelligence MCP server (READ-ONLY).
 *
 * This is the unprivileged half of the safety model. It can read the DreamDEX
 * venue, the underlying price feed, and on-chain market state. It has no signer,
 * no order verbs, and no path to one: `LiveMarketSource.create()` is called
 * without `withSigner`, so this process never loads a private key. Trading lives
 * in a separate server behind an explicit approval gate.
 *
 * That separation is the point. A model connected to this server can do the
 * entire analysis — discover markets, read evidence, check its own reasoning for
 * circularity — and is structurally incapable of placing an order.
 *
 * Transport is stdio. Nothing may be written to stdout except protocol frames;
 * see `log` in source.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { extractSignals, auditCitations, secondsLeft, hasHeadroom } from "@arena/market";
import { discover, getSource, resolve, log, usingFixtures, shutdown } from "./source.js";
import { marketLine, marketDetail, signalTable, underlyingLine, pct, duration } from "./format.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** Every tool here is a read. Declaring it in annotations lets a client show
 *  the user that this server cannot mutate anything — a claim in a description
 *  is prose, `readOnlyHint` is machine-checkable. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

const server = new McpServer({
  name: "agent-arena-intelligence",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------

server.registerTool(
  "discover_markets",
  {
    title: "Discover event contracts",
    description:
      "List active DreamDEX Event Contracts on the venue, soonest expiry first. These are " +
      "binary YES/NO contracts on BTC/ETH over fixed windows (15m / 1h / 4h / 24h). Start here.",
    inputSchema: {
      asset: z.string().optional().describe("Filter to one asset, e.g. BTC or ETH"),
      max: z.number().int().min(1).max(50).optional().describe("Max markets to return (default 10)"),
    },
    annotations: READ_ONLY,
  },
  async ({ asset, max }) => {
    const markets = await discover({ ...(asset ? { asset } : {}), max: max ?? 10 });
    if (!markets.length) return text("No active event contracts on this venue right now.");
    // NOT `.filter(hasHeadroom)`: Array.prototype.filter calls its callback as
    // (element, index, array), and hasHeadroom's second parameter is an
    // optional `fraction` with a default of 0.25 — passed bare, the ARRAY
    // INDEX silently overrides that default on every element past index 0.
    // A market at index 2 was being checked against fraction=2 (a 200%-of-
    // window threshold no live market ever clears), wrongly dropping markets
    // that clearly had headroom and wrongly naming a TOO-LATE market as the
    // best candidate whenever the truly-tradeable one wasn't at index 0.
    const tradeable = markets.filter((m) => hasHeadroom(m));
    return text(
      [
        `${markets.length} active event contract(s):`,
        ``,
        markets.map(marketLine).join("\n\n"),
        ``,
        `${tradeable.length} of ${markets.length} have enough window left to deliberate on.`,
        tradeable.length
          ? `Best candidate: ${tradeable[tradeable.length - 1]!.marketId} (most headroom).`
          : `None have headroom — every window is nearly closed. Wait for the next series.`,
      ].join("\n"),
    );
  },
);

// ---------------------------------------------------------------------------

server.registerTool(
  "get_market",
  {
    title: "Get contract detail",
    description:
      "Full detail for one contract: the settlement reference (what the underlying must beat), " +
      "authoritative on-chain status, timing, and the order book. Resolves the relative-contract " +
      "reference price, which the raw market row does not carry.",
    inputSchema: { marketId: z.string().describe("marketId from discover_markets") },
    annotations: READ_ONLY,
  },
  async ({ marketId }) => {
    const src = await getSource();
    const m = await resolve(marketId);
    const [book, ref, status] = await Promise.all([
      src.book(m),
      src.referencePrice(m),
      src.refreshStatus(m.marketId).catch(() => -1),
    ]);
    return text(marketDetail(m, book, ref, status));
  },
);

// ---------------------------------------------------------------------------

server.registerTool(
  "get_evidence",
  {
    title: "Get evidence for a contract",
    description:
      "THE MOST IMPORTANT TOOL. Returns every signal available for a contract, split into " +
      "INDEPENDENT evidence (underlying price, distance from the settlement reference, momentum, " +
      "time left) and CIRCULAR evidence (the contract's own book). Only independent evidence can " +
      "justify disagreeing with the market. Cite signals by id.",
    inputSchema: { marketId: z.string().describe("marketId from discover_markets") },
    annotations: READ_ONLY,
  },
  async ({ marketId }) => {
    const src = await getSource();
    const m = await resolve(marketId);
    const [book, ref] = await Promise.all([src.book(m), src.referencePrice(m)]);
    const under = await src.underlying(m.asset);
    const signals = extractSignals(m, book, under, ref);
    return text(
      [
        `Evidence for ${m.asset} ${duration(m.intervalSec)} contract (${m.marketId})`,
        `"${m.question}"`,
        `Time left: ${duration(secondsLeft(m))}`,
        ``,
        signalTable(signals),
      ].join("\n"),
    );
  },
);

// ---------------------------------------------------------------------------

server.registerTool(
  "get_orderbook",
  {
    title: "Get YES order book",
    description:
      "Top-of-book for the YES outcome. Prices ARE probabilities in (0,1). Use for liquidity " +
      "and execution decisions, not as a directional signal.",
    inputSchema: {
      marketId: z.string(),
      depth: z.number().int().min(1).max(20).optional().describe("Book depth (default 5)"),
    },
    annotations: READ_ONLY,
  },
  async ({ marketId, depth }) => {
    const src = await getSource();
    const m = await resolve(marketId);
    const book = await src.book(m, depth ?? 5);
    const spread =
      book.bestYesAsk !== undefined && book.bestYesBid !== undefined
        ? book.bestYesAsk - book.bestYesBid
        : undefined;
    return text(
      [
        `YES book — ${m.asset} ${duration(m.intervalSec)} (${m.marketId})`,
        `  bid ${pct(book.bestYesBid)}`,
        `  ask ${pct(book.bestYesAsk)}`,
        `  mid ${pct(book.yesMid)}`,
        spread !== undefined
          ? `  spread ${(spread * 100).toFixed(2)}pp — ${spread < 0.03 ? "tight" : spread < 0.1 ? "wide" : "illiquid"}`
          : `  spread n/a — book is one-sided or empty`,
        ``,
        spread !== undefined && spread >= 0.03
          ? `A ${(spread * 100).toFixed(1)}pp spread eats any edge smaller than roughly half of it.\n` +
            `Check this against your claimed edge before proposing a trade.`
          : ``,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  },
);

// ---------------------------------------------------------------------------

server.registerTool(
  "get_underlying",
  {
    title: "Get underlying spot price",
    description:
      "The BTC/ETH spot price and EMA mark from the venue's price feed. This is the ONLY " +
      "non-circular directional input — the contract's own price is a probability, so only " +
      "this feed knows where the asset actually is.",
    inputSchema: { asset: z.string().describe("BTC or ETH") },
    annotations: READ_ONLY,
  },
  async ({ asset }) => {
    const src = await getSource();
    const u = await src.underlying(asset);
    return text(underlyingLine(u, asset));
  },
);

// ---------------------------------------------------------------------------

server.registerTool(
  "implied_probability",
  {
    title: "Market-implied probability",
    description:
      "The market's own probability of YES, from the book mid. Returns it WITH an explicit " +
      "circularity warning: this is what you are trying to beat, not evidence that you are right.",
    inputSchema: { marketId: z.string() },
    annotations: READ_ONLY,
  },
  async ({ marketId }) => {
    const src = await getSource();
    const m = await resolve(marketId);
    const book = await src.book(m);
    if (book.yesMid === undefined) {
      return text(
        `No two-sided book for ${m.marketId} — the market has no implied probability right now.\n` +
          `Do NOT substitute 0.5. An absent book is missing information, not an even chance.`,
      );
    }
    return text(
      [
        `Market-implied P(YES) = ${pct(book.yesMid)}  (${m.asset}, ${duration(m.intervalSec)} window)`,
        `Market-implied P(NO)  = ${pct(1 - book.yesMid)}`,
        ``,
        `CIRCULARITY WARNING`,
        `This number IS the market's probability estimate. It is the benchmark your`,
        `analysis has to beat, not support for it. "The book says ${pct(book.yesMid)}, therefore`,
        `YES is likely" restates the price rather than reasoning about it.`,
        ``,
        `To claim an edge, ground it in independent evidence (get_evidence) — where the`,
        `underlying actually sits relative to the settlement reference, momentum, and`,
        `time remaining — then compare your number to this one.`,
      ].join("\n"),
    );
  },
);

// ---------------------------------------------------------------------------

server.registerTool(
  "audit_citations",
  {
    title: "Audit an argument for circular reasoning",
    description:
      "Check a set of cited signal ids against the evidence actually captured for a market. " +
      "Catches three failures mechanically: citing nothing, citing signals that were never " +
      "captured (fabrication), and building a directional case entirely out of the contract's " +
      "own price (circular reasoning). Run this on any argument before acting on it.",
    inputSchema: {
      marketId: z.string(),
      cites: z.array(z.string()).describe("Signal ids the argument rests on"),
      directional: z
        .boolean()
        .optional()
        .describe("True (default) if the argument claims a direction. False for pure risk/liquidity claims."),
    },
    annotations: READ_ONLY,
  },
  async ({ marketId, cites, directional }) => {
    const src = await getSource();
    const m = await resolve(marketId);
    const [book, ref] = await Promise.all([src.book(m), src.referencePrice(m)]);
    const under = await src.underlying(m.asset);
    const signals = extractSignals(m, book, under, ref);
    const findings = auditCitations(cites, signals, { directional: directional ?? true });

    if (!findings.length) {
      return text(
        `PASS — ${cites.length} citation(s) check out.\n` +
          `All cited ids exist, and the argument rests on at least one independent signal.`,
      );
    }
    const worst = findings.some((f) => f.severity === "fatal") ? "FATAL" : "MATERIAL";
    return text(
      [
        `${worst} — ${findings.length} finding(s):`,
        ``,
        ...findings.map(
          (f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.claim}` +
            (f.signalIds.length ? `\n   signals: ${f.signalIds.join(", ")}` : ""),
        ),
        ``,
        findings.some((f) => f.severity === "fatal")
          ? `A fatal finding means the argument does not support its conclusion. Revise it\n` +
            `against independent evidence rather than restating it.`
          : `Material findings weaken the argument without voiding it. Account for them.`,
      ].join("\n"),
    );
  },
);

// ---------------------------------------------------------------------------

async function main() {
  log(`starting — READ-ONLY (no signer, no order verbs)${usingFixtures() ? " [fixtures]" : ""}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("connected over stdio");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void shutdown().finally(() => process.exit(0)));
}

main().catch((e) => {
  log(`FATAL ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
