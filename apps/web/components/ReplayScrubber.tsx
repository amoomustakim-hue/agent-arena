"use client";

import type { RecordedEvent } from "@arena/core/blackbox.js";
import { describe } from "@/lib/derive";

export default function ReplayScrubber({
  all,
  seq,
  onChange,
}: {
  all: RecordedEvent[];
  seq: number;
  onChange: (seq: number) => void;
}) {
  const max = all.length ? Math.max(...all.map((e) => e.seq)) : 0;
  const current = all.find((e) => e.seq === seq);

  // Key beats worth a marker on the scrub rail — the moments a viewer would
  // actually want to jump straight to.
  const marks = all.filter((e) =>
    ["belief_revised", "challenge_issued", "verdict", "trade_executed", "settled"].includes(e.kind),
  );

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-hair bg-panel2 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => onChange(Math.max(0, seq - 1))}
            className="rounded-sm border border-hair px-2 py-0.5 text-2xs text-mid hover:border-hair2"
          >
            ← prev
          </button>
          <button
            onClick={() => onChange(Math.min(max, seq + 1))}
            className="rounded-sm border border-hair px-2 py-0.5 text-2xs text-mid hover:border-hair2"
          >
            next →
          </button>
          <button
            onClick={() => onChange(max)}
            className="rounded-sm border border-hair px-2 py-0.5 text-2xs text-mid hover:border-hair2"
          >
            live edge
          </button>
        </div>
        <span className="font-mono text-2xs uppercase tracking-wide text-dim">
          seq {seq} / {max}
          {current ? ` — ${describe(current)}` : ""}
        </span>
      </div>

      <div className="relative">
        <input
          type="range"
          min={0}
          max={max}
          value={seq}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full accent-indep"
        />
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -mt-[1px] h-[2px]">
          {marks.map((m) => (
            <span
              key={m.id}
              className="absolute top-0 h-[2px] w-[2px] -translate-x-1/2 bg-hair2"
              style={{ left: `${(m.seq / Math.max(1, max)) * 100}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
