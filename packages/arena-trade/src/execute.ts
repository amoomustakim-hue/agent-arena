/**
 * The gated executor — the §14 approval boundary, in code.
 *
 * TWO INDEPENDENT GATES, both required:
 *
 *   1. `DRY_RUN` must be explicitly `false`. It defaults to true, so the
 *      dangerous state is the one you have to opt into.
 *   2. A human approval callback must return true for THIS proposal.
 *
 * Neither alone is sufficient, and the structure enforces that rather than
 * documenting it: `send()` is not exported, and the only path to it runs
 * through both checks in `execute()`. There is no "force" parameter, because a
 * force parameter is how a two-gate system becomes a one-gate system.
 *
 * A read-only context (no PRIVATE_KEY) is a third de-facto gate — it cannot
 * sign at all — but it is not counted as one, because absence of a key is a
 * configuration accident rather than a decision.
 */

import { placeLimit, assertTxOk, type EcContext, type MarketOnchain, type PlacedOrder } from "@dreamdex-bot-kit/ec-core";
import type { BlackBox, EventId } from "@arena/core";
import type { Proposal } from "./propose.js";
import { marketStub, type VenueGrid } from "./venue.js";

/** Asked to approve one specific proposal. Returning anything but `true`
 *  blocks the trade. Must be answered by a human, not inferred. */
export type ApprovalGate = (p: Proposal, preview: OrderPreview) => Promise<boolean> | boolean;

/** Exactly what would go on the wire — integers included, because a dry run
 *  that shows floats has not shown you the order. */
export interface OrderPreview {
  outcome: "YES" | "NO";
  side: "buy";
  type: "post-only" | "ioc";
  priceHuman: number;
  sizeHuman: number;
  /** The integer price in the leg's own terms, as the pool will see it. */
  rawPrice: bigint;
  /** The integer price quoted to the book, always in YES terms. */
  rawPriceYes: bigint;
  rawSize: bigint;
  collateralAtRisk: number;
  expiresAt: number;
}

export interface ExecuteResult {
  executed: boolean;
  dryRun: boolean;
  reason?: string;
  order?: PlacedOrder;
  preview: OrderPreview;
}

export function preview(
  proposal: Proposal,
  grid: VenueGrid,
  onchain: MarketOnchain,
  expiresInSec = 300,
): OrderPreview {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    outcome: proposal.outcome,
    side: "buy",
    type: proposal.orderType,
    priceHuman: proposal.limitPrice,
    sizeHuman: proposal.size,
    rawPrice: grid.rawPrice(proposal.limitPrice),
    rawPriceYes: grid.rawPriceYes(proposal.limitPrice, proposal.outcome),
    rawSize: grid.rawSize(proposal.size),
    collateralAtRisk: proposal.maxLoss,
    // Orders must never outlive the market; placeLimit caps this too, but the
    // preview has to show the capped value or it is showing a different order.
    expiresAt: Math.min(nowSec + expiresInSec, Number(onchain.expiry)),
  };
}

export function renderPreview(p: OrderPreview): string {
  return [
    `  ${p.side.toUpperCase()} ${p.outcome}  ${p.sizeHuman} shares @ ${p.priceHuman}  (${p.type})`,
    `  risk:      ${p.collateralAtRisk} collateral`,
    `  raw price: ${p.rawPrice}  (quoted to book as YES ${p.rawPriceYes})`,
    `  raw size:  ${p.rawSize}`,
    `  expires:   ${new Date(p.expiresAt * 1000).toISOString()}`,
  ].join("\n");
}

/** The only function that sends. Deliberately not exported. */
async function send(
  ctx: EcContext,
  proposal: Proposal,
  onchain: MarketOnchain,
  symbol: string,
  expiresInSec: number,
): Promise<PlacedOrder> {
  const order = await placeLimit(ctx, {
    market: marketStub(proposal.marketId, symbol),
    onchain,
    outcome: proposal.outcome,
    side: "buy",
    price: proposal.limitPrice,
    size: proposal.size,
    type: proposal.orderType,
    expiresInSec,
  });
  // The SDK skips simulation and resolves with a receipt it never checks, so a
  // reverted order looks exactly like a successful one until you look.
  assertTxOk({ ...(order.hash ? { hash: order.hash } : {}) }, `${proposal.outcome} order`);
  return order;
}

export interface ExecuteInput {
  ctx: EcContext;
  proposal: Proposal;
  onchain: MarketOnchain;
  grid: VenueGrid;
  symbol: string;
  approve: ApprovalGate;
  blackbox: BlackBox;
  /** Events that led here — the risk verdict and the proposal. */
  causedBy?: EventId[];
  expiresInSec?: number;
}

export async function execute(input: ExecuteInput): Promise<ExecuteResult> {
  const { ctx, proposal, onchain, grid, symbol, approve, blackbox } = input;
  const expiresInSec = input.expiresInSec ?? 300;
  const view = preview(proposal, grid, onchain, expiresInSec);
  const causedBy = input.causedBy ?? [];

  // ---- GATE 1: explicit human approval, for this proposal.
  const approved = await approve(proposal, view);
  if (approved !== true) {
    blackbox.record({ kind: "trade_rejected", actor: "user", why: "not approved" }, causedBy);
    return { executed: false, dryRun: ctx.config.dryRun, reason: "Rejected at the approval gate.", preview: view };
  }
  const approvalId = blackbox.record({ kind: "trade_approved", actor: "user" }, causedBy);

  // ---- GATE 2: DRY_RUN must be explicitly disabled.
  if (ctx.config.dryRun) {
    blackbox.record(
      { kind: "trade_executed", txHash: "dry-run", dryRun: true, filled: 0 },
      [approvalId],
    );
    return {
      executed: false,
      dryRun: true,
      reason:
        "DRY_RUN is on — approved, but nothing was sent. The order above is exactly what " +
        "would have gone on the wire. Set DRY_RUN=false to arm execution.",
      preview: view,
    };
  }

  // Both gates passed. A signer is still required to sign.
  if (!ctx.canTrade) {
    blackbox.record({ kind: "trade_rejected", actor: "system", why: "no signer" }, [approvalId]);
    return {
      executed: false,
      dryRun: false,
      reason: "Approved and armed, but no PRIVATE_KEY is loaded — this process cannot sign.",
      preview: view,
    };
  }

  try {
    const order = await send(ctx, proposal, onchain, symbol, expiresInSec);
    if (order.size === 0) {
      // placeLimit returns a zero-size no-op rather than throwing when a size
      // floors off the lot grid or the market has already expired.
      blackbox.record({ kind: "trade_rejected", actor: "system", why: "size floored to zero" }, [approvalId]);
      return {
        executed: false,
        dryRun: false,
        reason: "placeLimit sent nothing: size floored to 0 on the lot grid, or the window closed.",
        preview: view,
      };
    }
    blackbox.record(
      { kind: "trade_executed", txHash: order.hash ?? "unknown", dryRun: false, filled: order.filled },
      [approvalId],
    );
    return { executed: true, dryRun: false, order, preview: view };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    blackbox.record({ kind: "trade_rejected", actor: "system", why }, [approvalId]);
    return { executed: false, dryRun: false, reason: why, preview: view };
  }
}

/** An approval gate that always refuses. The default for anything unattended:
 *  a missing gate should mean "no trade", never "trade freely". */
export const denyAll: ApprovalGate = () => false;

/** Prompt a human on the terminal. Anything but `yes` refuses. */
export function terminalGate(): ApprovalGate {
  return async (p, view) => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`\nAPPROVAL REQUIRED\n${renderPreview(view)}\n\n  ${p.reasoning}\n  Invalidated by: ${p.invalidation}\n`);
    const answer = (await rl.question(`Approve this trade? Type "yes" to approve: `)).trim().toLowerCase();
    rl.close();
    return answer === "yes";
  };
}
