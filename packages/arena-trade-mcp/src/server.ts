#!/usr/bin/env node
/**
 * Agent Arena — Trading MCP server (the "privileged" half — that stops short
 * of actually being privileged).
 *
 * The vision doc calls for a Trading MCP with prepare/validate/execute verbs.
 * This server has the first two. It deliberately does NOT have a tool that can
 * send a real order, and that omission is the design, not a gap:
 *
 * MCP has no protocol-level signal that distinguishes "a human clicked
 * approve" from "an LLM client decided to call this tool." The vision doc's
 * safety model requires the former — "no autonomous execution without an
 * explicit user approval boundary" — and a tool call from an MCP client
 * cannot prove that boundary was crossed by a person rather than inferred by
 * a model. So rather than build an execute_trade tool and hope callers only
 * invoke it after real human confirmation, this server makes the honest
 * trade: no tool here can move funds, structurally, twice over —
 *
 *   1. This process never calls `createExchange({ withSigner: true })`.
 *      There is no key loaded anywhere in this server's lifetime.
 *   2. `preview_execution` calls arena-trade's `execute()`, whose own two-gate
 *      logic (DRY_RUN, then signer) refuses to send without a signer
 *      regardless of what DRY_RUN says. Point 1 makes that refusal
 *      unconditional here.
 *
 * The one place a real order can be sent is `arena-trade/src/cli.ts`'s
 * `terminalGate()` — a real terminal, a real human typing "yes". That is the
 * only channel in this codebase where "a human approved this" is actually
 * verifiable, and it is deliberately not exposed over MCP.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { propose, assess, execute, outcomeOf, type ExecuteInput } from "@arena/trade";
import { resolve, onchain, grid, fees, getSource, getContext, log, usingFixtures, shutdown } from "./source.js";
import { renderProposal, renderRisk, renderPreviewOrder } from "./format.js";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

const server = new McpServer({ name: "agent-arena-trading", version: "0.1.0" });

const tradeArgs = {
  marketId: z.string().describe("marketId from the intelligence server's discover_markets"),
  councilP: z.number().min(0.01).max(0.99).describe("The council's probability that YES settles true"),
  budget: z.number().positive().optional().describe("Collateral to risk on this contract (default 300)"),
  minEv: z.number().optional().describe("Minimum EV per share to bother, in probability units (default 0.02)"),
  orderType: z.enum(["post-only", "ioc"]).optional().describe("post-only rests, may not fill; ioc crosses the spread (default)"),
};

async function buildProposal(args: {
  marketId: string;
  councilP: number;
  budget?: number;
  minEv?: number;
  orderType?: "post-only" | "ioc";
}) {
  const src = await getSource();
  const market = await resolve(args.marketId);
  const [book, reference] = await Promise.all([src.book(market), src.referencePrice(market)]);
  const oc = await onchain(args.marketId);
  const g = grid();
  const f = await fees(args.marketId, oc);

  const result = propose({
    market,
    book,
    reference,
    councilP: args.councilP,
    grid: g,
    fees: f,
    budget: args.budget ?? 300,
    minEv: args.minEv,
    orderType: args.orderType,
  });

  return { market, book, oc, grid: g, fees: f, result };
}

// ---------------------------------------------------------------------------

server.registerTool(
  "propose_trade",
  {
    title: "Propose a trade from a council verdict",
    description:
      "Turn a probability into a priced, risk-checked proposal — or an explicit refusal when the " +
      "edge doesn't clear costs. Computes EV against the price you'd actually pay (not the mid), " +
      "after the settlement fee. Read-only: this tool cannot send anything.",
    inputSchema: tradeArgs,
    annotations: READ_ONLY,
  },
  async (args) => {
    const { market, oc, grid: g, result } = await buildProposal(args);
    const riskVerdict = "outcome" in result
      ? assess({
          proposal: result,
          market,
          book: await (await getSource()).book(market),
          onchain: oc,
          grid: g,
        })
      : null;

    return text(
      [
        renderProposal(result),
        riskVerdict ? `\n${renderRisk(riskVerdict)}` : "",
        riskVerdict && !riskVerdict.ok
          ? "\nThis proposal exists but RISK BLOCKS it. Do not treat it as actionable."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  },
);

// ---------------------------------------------------------------------------

server.registerTool(
  "preview_execution",
  {
    title: "Preview the exact order (never sends)",
    description:
      "Show precisely what would go on the wire for this proposal — integer price and size, in the " +
      "venue's own grid units, not the floats they came from. ALWAYS a preview: this server never " +
      "loads a signer, so nothing it does can execute regardless of DRY_RUN. Real execution only " +
      "happens from the arena-trade CLI, where a human types \"yes\" at a real terminal.",
    inputSchema: tradeArgs,
    annotations: READ_ONLY,
  },
  async (args) => {
    const { market, oc, grid: g, result } = await buildProposal(args);
    if (!("outcome" in result)) {
      return text(`Nothing to preview — ${renderProposal(result)}`);
    }

    const ctx = getContext();
    const input: ExecuteInput = {
      ctx,
      proposal: result,
      onchain: oc,
      grid: g,
      symbol: market.symbol,
      // Approval gate 1 asks "does the caller want to see the preview" —
      // trivially yes, since calling this tool IS that request. Gate 2 (and
      // this process never holding a signer) is what actually prevents a
      // send; this gate is not load-bearing for safety.
      approve: () => true,
      blackbox: { record: () => "" } as any, // this server keeps no session ledger — see server.ts header
    };
    const outcome = await execute(input);

    return text(
      [
        `PREVIEW ONLY — canTrade=${ctx.canTrade} dryRun=${ctx.config.dryRun}`,
        `(This process never loads a signer, so execution is structurally impossible here` +
          ` regardless of either value above.)`,
        ``,
        renderPreviewOrder(outcome.preview),
        ``,
        outcome.reason ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  },
);

// ---------------------------------------------------------------------------

server.registerTool(
  "check_settlement",
  {
    title: "Check whether a contract has settled",
    description:
      "Read the on-chain outcome for a market: still open, YES, NO, or VOID. Read-only — does not " +
      "claim winnings. Claiming is a write and stays out of MCP for the same reason execution does.",
    inputSchema: { marketId: z.string() },
    annotations: READ_ONLY,
  },
  async ({ marketId }) => {
    const oc = await onchain(marketId);
    const outcome = outcomeOf(oc);
    if (outcome === null) {
      return text(`${marketId} has not settled yet (on-chain status ${oc.status}).`);
    }
    if (outcome === "VOID") {
      return text(`${marketId} was VOIDED. The question was withdrawn — nobody is scored on a voided market.`);
    }
    return text(
      `${marketId} settled ${outcome}.\n` +
        `Agent scoring reads this alongside the council's belief history — see the reputation ` +
        `tools, which need the Black Box this server does not hold.`,
    );
  },
);

// ---------------------------------------------------------------------------

async function main() {
  log(`starting — privileged in scope, zero fund-moving tools${usingFixtures() ? " [fixtures]" : ""}`);
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
