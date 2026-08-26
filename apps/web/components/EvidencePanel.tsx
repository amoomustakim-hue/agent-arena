"use client";

import type { EventId, RecordedEvent } from "@arena/core/blackbox.js";
import { allSignals, isCircular } from "@/lib/derive";
import { Panel, Chip } from "./ui";

export default function EvidencePanel({
  visible,
  dead,
  activeId,
  onToggle,
}: {
  visible: RecordedEvent[];
  /** Ids killed by the current counterfactual removal, or null when none is
   *  active. Rows in this set render struck-through and dimmed. */
  dead: Set<EventId> | null;
  activeId: EventId | null;
  onToggle: (eventId: EventId, label: string) => void;
}) {
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
          dead={dead}
          activeId={activeId}
          onToggle={onToggle}
        />
        <Column
          label="Circular"
          hint="The contract's own price — describes the market, cannot argue with it"
          color="#ff9d3d"
          rows={circular}
          dead={dead}
          activeId={activeId}
          onToggle={onToggle}
        />
      </div>
      <p className="mt-3 text-2xs text-dim">
        Click a signal to counterfactually remove it — everything causally downstream greys out
        across the page, and the verdict panel says whether it survives.
      </p>
    </Panel>
  );
}

function Column({
  label,
  hint,
  color,
  rows,
  dead,
  activeId,
  onToggle,
}: {
  label: string;
  hint: string;
  color: string;
  rows: ReturnType<typeof allSignals>;
  dead: Set<EventId> | null;
  activeId: EventId | null;
  onToggle: (eventId: EventId, label: string) => void;
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
        {rows.map(({ event, signal }) => {
          const isDead = dead?.has(event.id) ?? false;
          const isActive = activeId === event.id;
          return (
            <button
              key={event.id}
              onClick={() => onToggle(event.id, signal.label)}
              className={`flex items-center justify-between gap-3 px-2.5 py-1.5 text-left transition-opacity hover:bg-panel2 ${
                isDead ? "opacity-35" : ""
              }`}
              style={isActive ? { boxShadow: "inset 2px 0 0 #ff3b4e" } : undefined}
            >
              <div className="min-w-0">
                <div className={`truncate text-xs text-bright ${isDead ? "line-through" : ""}`}>
                  {signal.label}
                </div>
                <div className="truncate text-2xs text-dim">{signal.source}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!!signal.staleness && signal.staleness > 30 && (
                  <Chip color="#ffb020">{signal.staleness}s old</Chip>
                )}
                <span className={`tabular font-mono text-sm text-mid ${isDead ? "line-through" : ""}`}>
                  {signal.value}
                  {signal.unit ?? ""}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
