# `@arena/trade-mcp` — Trading MCP Server

The vision doc's Trading MCP — proposal economics, risk validation, and order
preview over MCP. It deliberately has **no tool that can send a real order.**

## Why no execution tool

MCP has no protocol-level way to distinguish "a human clicked approve" from
"an LLM client decided to call this tool." The safety model this project
commits to (§14) requires the former — no autonomous execution without an
explicit human approval boundary — and a tool call cannot prove that boundary
was actually crossed by a person rather than inferred by a model.

So rather than build an `execute_trade` tool and hope callers only invoke it
after real human confirmation, every tool here stops one step short of
sending, **structurally, twice over**:

1. This process never calls `createExchange({ withSigner: true })`. There is
   no private key loaded anywhere in this server's lifetime.
2. `preview_execution` calls `arena-trade`'s `execute()`, whose own two-gate
   logic refuses to send without a signer regardless of what `DRY_RUN` says.
   Point 1 makes that refusal unconditional here.

The one place a real order can be sent in this codebase is
`arena-trade/src/cli.ts`'s `terminalGate()` — a real terminal, a human typing
`yes`. That is the only channel where "a human approved this" is actually
verifiable, and it is deliberately not exposed over MCP.

---

## Tools

| Tool | Purpose |
|---|---|
| `propose_trade` | Council probability → priced, risk-checked proposal, or an explicit refusal when the edge doesn't clear costs |
| `preview_execution` | The exact wire-level order — integer price and size, not the floats they came from — with a note on why it can never actually send |
| `check_settlement` | On-chain outcome for a market: open, YES, NO, or VOID. Does not claim — claiming is a write, same reasoning as execution |

## Real output, live testnet

```
propose_trade  {marketId, councilP: 0.8, budget: 50}
→ PROPOSAL — buy YES
    size:        80.906148 shares
    limit price: 61.8%  (ioc)
    council:     80.0%  vs market 60.3%
    edge:        18.20pp/share
  RISK — PASS
    1. 388s left is close to the 300s floor. Expect little room to manage the position.

preview_execution  {marketId, councilP: 0.8, budget: 50}
→ PREVIEW ONLY — canTrade=false dryRun=true
  (This process never loads a signer, so execution is structurally
   impossible here regardless of either value above.)
    BUY YES  83.61204 shares @ 59.8%  (ioc)
    raw price: 598000  (quoted to book as YES 598000)
    raw size:  83612040
```

Note the price moved between the two calls (61.8% → 59.8%) — that's the live
book, not a bug. Every proposal is priced against the market as it actually
is at call time.

## Connect it

Same shape as `@arena/mcp` — see that package's README for the client config
block; swap the entry file for `packages/arena-trade-mcp/src/server.ts`.

```bash
pnpm exec tsx packages/arena-trade-mcp/scripts/smoke.ts            # live
pnpm exec tsx packages/arena-trade-mcp/scripts/smoke.ts --fixtures # offline
```
