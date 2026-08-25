"use client";

import type { RecordedEvent } from "@arena/core/blackbox.js";
import { allSignals, isCircular } from "@/lib/derive";
import { Panel, Chip } from "./ui";

export default function EvidencePanel({ visible }: { visible: RecordedEvent[] }) {
  const signals = allSignals(visible);
  const independent = signals.filter((s) => !isCircular(s.signal));
  const circular = signals.filter((s) => isCircular(s.signal));

  return (
    <Panel eyebrow="Exhibit 02" title="Evidence">
      <div className="flex flex-col gap-4">
        <Column
          label="Independent"
          hint="Can justify disagreeing with the market"
          color="#2ee6a8"
          rows={independent}
        />
        <Column
          label="Circular"
          hint="The contract's own price — describes the market, cannot argue with it"
          color="#ff9d3d"
          rows={circular}
        />
      </div>
    </Panel>
  );
}

function Column({
  label,
  hint,
  color,
  rows,
}: {
  label: string;
  hint: string;
  color: string;
  rows: ReturnType<typeof allSignals>;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: color, boxShadow: `0 0 6px ${color}` }}
        />
        <span className="text-2xs font-mono uppercase tracking-widest" style={{ color }}>
          {label} ({rows.length})
        </span>
      </div>
      <p className="mb-2 text-2xs text-dim">{hint}</p>
      <div className="flex flex-col divide-y divide-hair rounded-sm border border-hair">
        {rows.length === 0 && (
          <div className="px-2.5 py-2 text-2xs text-dim">— none captured yet —</div>
        )}
        {rows.map(({ event, signal }) => (
          <div key={event.id} className="flex items-center justify-between gap-3 px-2.5 py-1.5">
            <div className="min-w-0">
              <div className="truncate text-xs text-bright">{signal.label}</div>
              <div className="truncate text-2xs text-dim">{signal.source}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!!signal.staleness && signal.staleness > 30 && (
                <Chip color="#ffb020">{signal.staleness}s old</Chip>
              )}
              <span className="tabular font-mono text-sm text-mid">
                {signal.value}
                {signal.unit ?? ""}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
