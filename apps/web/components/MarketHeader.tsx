"use client";

import type { RecordedEvent } from "@arena/core/blackbox.js";
import { findEvent } from "@/lib/derive";

export default function MarketHeader({ all, visible }: { all: RecordedEvent[]; visible: RecordedEvent[] }) {
  const market = findEvent(all, "market_observed");
  if (!market) return null;

  const settled = findEvent(visible, "settled");
  const isRelative = market.strike === 0;
  const expiresAt = new Date(market.expiry * 1000);
  const windowStart = new Date((market.expiry - market.intervalSec) * 1000);

  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-hair pb-4">
      <div>
        <div className="flex items-center gap-2 text-2xs font-mono uppercase tracking-widest text-dim">
          <span>Agent Arena</span>
          <span>·</span>
          <span>War room</span>
          <span>·</span>
          <span className="text-mid">{market.marketId.slice(0, 12)}…</span>
        </div>
        <h1 className="mt-1 text-xl font-semibold text-bright">{market.symbol}</h1>
        <p className="mt-0.5 text-xs text-dim">
          {isRelative
            ? "Relative contract — YES settles true if the underlying closes at or above its window-opening price."
            : `Settles YES at or above ${market.strike}.`}{" "}
          Window {windowStart.toISOString().slice(11, 16)}–{expiresAt.toISOString().slice(11, 16)} UTC (
          {market.intervalSec}s).
        </p>
      </div>

      <div className="flex items-center gap-4">
        {market.yesMid !== undefined && (
          <Stat label="Book, at open" value={`${(market.yesMid * 100).toFixed(1)}%`} />
        )}
        <Stat
          label="Status"
          value={settled ? `Settled ${settled.outcome}` : "In session"}
          accent={settled ? (settled.outcome === "NO" ? "#ff5d6c" : settled.outcome === "YES" ? "#3ddc84" : "#8c9bb0") : "#2ee6a8"}
        />
      </div>
    </header>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="text-right">
      <div className="text-2xs font-mono uppercase tracking-widest text-dim">{label}</div>
      <div className="tabular font-mono text-sm" style={{ color: accent ?? "#dce6f2" }}>
        {value}
      </div>
    </div>
  );
}
