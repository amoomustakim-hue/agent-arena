"use client";

import Link from "next/link";
import type { RecordedEvent } from "@arena/core/blackbox.js";
import { findEvent } from "@/lib/derive";
import ConnectWallet from "./ConnectWallet";

export default function MarketHeader({ all, visible }: { all: RecordedEvent[]; visible: RecordedEvent[] }) {
  const market = findEvent(all, "market_observed");
  if (!market) return null;

  const settled = findEvent(visible, "settled");
  const isRelative = market.strike === 0;
  // A live session's market_observed can legitimately arrive with an
  // unresolved window (a parser miss on the backend, a future event kind
  // that doesn't carry timing) — treat that as "unknown," never construct a
  // Date from it. `new Date(NaN).toISOString()` throws RangeError: Invalid
  // time value, which took the whole live session page down the moment its
  // first event arrived until this guard existed; a missing window is
  // something to say plainly, not something that should be able to crash
  // the page it's rendered on.
  const hasWindow =
    Number.isFinite(market.expiry) && market.expiry > 0 &&
    Number.isFinite(market.intervalSec) && market.intervalSec > 0;
  const expiresAt = hasWindow ? new Date(market.expiry * 1000) : null;
  const windowStart = hasWindow ? new Date((market.expiry - market.intervalSec) * 1000) : null;

  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-hair pb-4">
      <div>
        <div className="flex items-center gap-2 text-2xs font-mono uppercase tracking-widest text-dim">
          <span>Agent Arena</span>
          <span>·</span>
          <span>War room</span>
          <span>·</span>
          <span className="text-mid">{market.marketId.slice(0, 12)}…</span>
          <span>·</span>
          <Link href="/reputation" className="hover:text-mid">
            Reputation
          </Link>
          <span>·</span>
          <Link href="/markets" className="hover:text-mid">
            Convene a live council →
          </Link>
        </div>
        <h1 className="mt-1 text-xl font-semibold text-bright">{market.symbol}</h1>
        <p className="mt-0.5 text-xs text-dim">
          {isRelative
            ? "Relative contract — YES settles true if the underlying closes at or above its window-opening price."
            : `Settles YES at or above ${market.strike}.`}{" "}
          {hasWindow && windowStart && expiresAt
            ? `Window ${windowStart.toISOString().slice(11, 16)}–${expiresAt.toISOString().slice(11, 16)} UTC (${market.intervalSec}s).`
            : "Window timing not yet resolved."}
        </p>
      </div>

      <div className="flex items-center gap-4">
        {market.yesMid !== undefined && (
          <Stat label="Book, at open" value={`${(market.yesMid * 100).toFixed(1)}%`} />
        )}
        <Stat
          label="Status"
          value={settled ? `Settled ${settled.outcome}` : "In session"}
          strong={!!settled}
        />
        <ConnectWallet />
      </div>
    </header>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="text-right">
      <div className="text-2xs font-mono uppercase tracking-widest text-dim">{label}</div>
      <div className={`tabular font-mono text-sm ${strong ? "font-semibold text-bright" : "text-mid"}`}>
        {value}
      </div>
    </div>
  );
}
