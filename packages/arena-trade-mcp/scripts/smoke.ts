/**
 * End-to-end smoke test: real MCP client, real stdio transport, live venue.
 *
 *   pnpm exec tsx packages/arena-trade-mcp/scripts/smoke.ts
 *   pnpm exec tsx packages/arena-trade-mcp/scripts/smoke.ts --fixtures
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "server.ts");
const fixtures = process.argv.includes("--fixtures");

const show = (label: string, res: any) => {
  const body = (res?.content ?? []).map((c: any) => c.text).join("\n");
  console.log(`\n${"=".repeat(70)}\n${label}\n${"=".repeat(70)}\n${body}`);
};

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs"), serverPath, ...(fixtures ? ["--fixtures"] : [])],
    env: { ...process.env, ...(fixtures ? { ARENA_FIXTURES: "true" } : {}) } as Record<string, string>,
  });

  const client = new Client({ name: "arena-trade-smoke", version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`tools/list → ${tools.length} tools`);
  for (const t of tools) {
    const ro = (t.annotations as any)?.readOnlyHint === true ? "read-only" : "!! MUTATING !!";
    console.log(`  ${t.name.padEnd(20)} [${ro}]`);
  }

  // Discover a live marketId the same way the intelligence server would.
  const { LiveMarketSource } = await import("@arena/market/live.js");
  const { FixtureMarketSource } = await import("@arena/market/fixtures.js");
  const src = fixtures ? FixtureMarketSource.synthetic() : LiveMarketSource.create();
  const markets = await src.discover({ max: 5 });
  const market = markets.find((m) => m.marketId) ?? markets[0];
  await src.close();
  if (!market) {
    console.log("\nNo market found — cannot exercise the trading tools.");
    await client.close();
    return;
  }
  console.log(`\nUsing marketId ${market.marketId} (${market.asset} ${market.intervalSec}s)`);

  // A council probability deliberately far from 50/50, so there is a real
  // proposal to look at rather than every case falling into "no trade."
  show(
    "propose_trade — council confident on YES",
    await client.callTool({
      name: "propose_trade",
      arguments: { marketId: market.marketId, councilP: 0.8, budget: 50 },
    }),
  );

  show(
    "preview_execution — same inputs",
    await client.callTool({
      name: "preview_execution",
      arguments: { marketId: market.marketId, councilP: 0.8, budget: 50 },
    }),
  );

  show(
    "propose_trade — council basically agrees with the market (should refuse)",
    await client.callTool({
      name: "propose_trade",
      arguments: { marketId: market.marketId, councilP: 0.51, budget: 50 },
    }),
  );

  show(
    "check_settlement",
    await client.callTool({ name: "check_settlement", arguments: { marketId: market.marketId } }),
  );

  await client.close();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("SMOKE FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
