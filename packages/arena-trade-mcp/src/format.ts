import type { Proposal, NoTrade } from "@arena/trade";
import { isProposal } from "@arena/trade";
import type { RiskVerdict } from "@arena/trade";
import type { OrderPreview } from "@arena/trade";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function renderProposal(r: Proposal | NoTrade): string {
  if (!isProposal(r)) {
    return [`NO TRADE — ${(r as NoTrade).reason}`, "", (r as NoTrade).detail].join("\n");
  }
  return [
    `PROPOSAL — buy ${r.outcome}`,
    `  size:        ${r.size} shares`,
    `  limit price: ${pct(r.limitPrice)}  (${r.orderType})`,
    `  max loss:    ${r.maxLoss.toFixed(6)} collateral`,
    `  council:     ${pct(r.councilP)}  vs market ${pct(r.marketP)}`,
    `  breakeven:   ${pct(r.breakeven)} after fees`,
    `  edge:        ${(r.evPerShare * 100).toFixed(2)}pp/share`,
    ``,
    `Reasoning: ${r.reasoning}`,
    `Invalidation: ${r.invalidation}`,
  ].join("\n");
}

export function renderRisk(v: RiskVerdict): string {
  const lines = [`RISK — ${v.ok ? "PASS" : "BLOCKED"}`];
  if (v.concerns.length) {
    lines.push("", "Blocking concerns:");
    v.concerns.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  }
  if (v.warnings.length) {
    lines.push("", "Warnings (non-blocking):");
    v.warnings.forEach((w, i) => lines.push(`  ${i + 1}. ${w}`));
  }
  if (v.ok && !v.warnings.length) lines.push("No concerns.");
  return lines.join("\n");
}

export function renderPreviewOrder(p: OrderPreview): string {
  return [
    `  ${p.side.toUpperCase()} ${p.outcome}  ${p.sizeHuman} shares @ ${pct(p.priceHuman)}  (${p.type})`,
    `  raw price: ${p.rawPrice}  (quoted to book as YES ${p.rawPriceYes})`,
    `  raw size:  ${p.rawSize}`,
    `  collateral at risk: ${p.collateralAtRisk.toFixed(6)}`,
    `  would expire: ${new Date(p.expiresAt * 1000).toISOString()}`,
  ].join("\n");
}
