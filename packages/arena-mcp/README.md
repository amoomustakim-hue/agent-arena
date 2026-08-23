# `@arena/mcp` — Market Intelligence MCP Server

Read-only MCP access to DreamDEX Event Contracts: live markets, evidence,
on-chain status, and a mechanical circular-reasoning audit.

This is the **unprivileged half** of Agent Arena's safety model. It has no
signer, no order verbs, and no path to one — `LiveMarketSource.create()` is
called without `withSigner`, so this process never loads a private key. Every
tool is annotated `readOnlyHint: true`, which is machine-checkable by the client
rather than a promise in a description.

A model connected to this server can perform the entire analysis and is
structurally incapable of placing an order.

---

## Connect it

Add to your MCP client config (Claude Code: `.mcp.json` in the project root, or
`claude mcp add`; Claude Desktop: `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agent-arena": {
      "command": "npx",
      "args": ["-y", "tsx", "packages/arena-mcp/src/server.ts"],
      "cwd": "c:/Users/Musty/OneDrive/Desktop/OLEX",
      "env": { "NETWORK": "testnet" }
    }
  }
}
```

Add `"ARENA_FIXTURES": "true"` to the `env` block to run with no network at all.

Verify it end to end without a client:

```bash
pnpm exec tsx packages/arena-mcp/scripts/smoke.ts            # live venue
pnpm exec tsx packages/arena-mcp/scripts/smoke.ts --fixtures # offline
```

---

## Tools

| Tool | Purpose |
|---|---|
| `discover_markets` | Active contracts, soonest expiry first, flagged for whether there is enough window left to deliberate |
| `get_market` | Full detail incl. the **resolved settlement reference** and authoritative on-chain status |
| `get_evidence` | **The important one.** Every signal, split independent vs circular |
| `get_orderbook` | YES top-of-book with spread and a liquidity read |
| `get_underlying` | BTC/ETH spot + EMA mark, with staleness |
| `implied_probability` | The market's own P(YES), returned with an explicit circularity warning |
| `audit_citations` | Check an argument's cited signal ids for fabrication and circular reasoning |

### `get_evidence` — why it is the centre

Signals are tagged by origin, and the split is load-bearing:

- **Independent** (`underlying`, `chain`, `clock`) — where BTC actually is, how far
  that is from the settlement reference, momentum, time left. These can justify
  disagreeing with the market.
- **Circular** (`book`, `derived`) — the contract's own order book. The book price
  **is** the market's probability estimate, so citing it as grounds to disagree
  with the market is question-begging.

This is the venue's easiest mistake, because restating the price always *sounds*
like analysis. The dreamDEX kit warns about it in its own source:

> `fetchOrderBook` and `watchPrice`-on-a-symbol give you the event contract's OWN
> price (a probability), which is circular as a directional signal. Only the feed
> knows where BTC actually is. — `ec-core/config.ts`

### `audit_citations` — three failures caught deterministically

Run it on any argument before acting on it. Real output:

```
audit_citations  cites: ["market_implied", "spread"]
→ FATAL — Directional case rests entirely on the contract's own price
  (market_implied, spread). The book IS the market's probability — citing
  it as a reason to disagree with the market is circular.

audit_citations  cites: ["strike_distance", "time_left"]
→ PASS — 2 citation(s) check out. All cited ids exist, and the argument
  rests on at least one independent signal.

audit_citations  cites: ["cnbc_headline"]
→ FATAL — Cited evidence that was never captured: cnbc_headline.
  This is fabrication, not inference.
```

These checks are mechanical and run before any LLM sees the argument. An LLM
asked to police circular reasoning will miss it sometimes; a set-membership test
on signal origins cannot. Cheap checks first, expensive judgment second.

---

## Two venue facts the tools encode

**`strike: "0"` is a sentinel, not a missing field.** The live series are
*relative* contracts — "BTC closes at or above its opening price". The reference
is the underlying's price at `tradingStart`, resolved from the price-feed candle
covering that instant. Treating the 0 as a strike yields `distance = Infinity`,
which reads as total conviction and means nothing. `get_market` states the real
reference and its provenance; when it cannot be resolved it says `UNRESOLVED`
rather than guessing, and `audit_citations` treats a directional claim built on
an unresolved reference as fatal.

**The indexer lags the chain.** `get_market` reports status read from chain, not
from the indexer's `active` flag. Only status 1 (Trading) accepts orders.

---

## Notes for anyone extending this

**stdout is the protocol channel.** Anything written there corrupts the stream
and the client disconnects with a parse error that looks like the server never
started. All diagnostics go to stderr via `log()` in `source.ts`. This is the
single easiest way to break an MCP server.

Tool output is prose-shaped rather than JSON because these are read by models.
Units and provenance travel with every number, and circular signals are
re-labelled at each point of use — a caller who reads only one tool's output
must still be told that the book price is the market's own estimate.
