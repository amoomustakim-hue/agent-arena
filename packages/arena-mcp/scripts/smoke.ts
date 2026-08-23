/**
 * End-to-end smoke test: spawn the server over stdio and drive it as a real
 * MCP client. Verifies the wire protocol, not just that the module imports.
 *
 *   pnpm exec tsx packages/arena-mcp/scripts/smoke.ts            # live venue
 *   pnpm exec tsx packages/arena-mcp/scripts/smoke.ts --fixtures # offline
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

  const client = new Client({ name: "arena-smoke", version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`tools/list → ${tools.length} tools`);
  for (const t of tools) {
    const ro = (t.annotations as any)?.readOnlyHint === true ? "read-only" : "MUTATING";
    console.log(`  ${t.name.padEnd(22)} [${ro}]`);
  }

  const discovered = await client.callTool({ name: "discover_markets", arguments: { max: 3 } });
  show("discover_markets", discovered);

  // Pull a marketId out of the text so the rest of the run is self-driving.
  const body = ((discovered as any).content ?? []).map((c: any) => c.text).join("\n");
  // Fixture ids are not pure hex (`0xfixture0001`), so match on the 0x prefix
  // plus word chars rather than a hex class.
  const marketId = body.match(/0x\w{6,}/)?.[0];
  if (!marketId) {
    console.log("\nNo marketId found — cannot exercise the remaining tools.");
    await client.close();
    return;
  }
  console.log(`\nUsing marketId ${marketId}`);

  show("get_market", await client.callTool({ name: "get_market", arguments: { marketId } }));
  show("get_evidence", await client.callTool({ name: "get_evidence", arguments: { marketId } }));
  show("implied_probability", await client.callTool({ name: "implied_probability", arguments: { marketId } }));

  // The audit is the point of the server. Prove both branches.
  show(
    "audit_citations — CIRCULAR argument (should FAIL)",
    await client.callTool({
      name: "audit_citations",
      arguments: { marketId, cites: ["market_implied", "spread"], directional: true },
    }),
  );
  show(
    "audit_citations — grounded argument (should PASS)",
    await client.callTool({
      name: "audit_citations",
      arguments: { marketId, cites: ["strike_distance", "time_left"], directional: true },
    }),
  );
  show(
    "audit_citations — fabricated id (should FAIL)",
    await client.callTool({
      name: "audit_citations",
      arguments: { marketId, cites: ["cnbc_headline"], directional: true },
    }),
  );

  await client.close();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("SMOKE FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
