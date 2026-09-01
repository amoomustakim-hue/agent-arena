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
          filled
          rows={independent}
          dead={dead}
          activeId={activeId}
          onToggle={onToggle}
        />
        <Column
          label="Circular"
          hint="The contract's own price — describes the market, cannot argue with it"
          filled={false}
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
  filled,
  rows,
  dead,
  activeId,
  onToggle,
}: {
  label: string;
  hint: string;
  /** Independent evidence gets a solid dot and full-weight label — it's
   *  the evidence that can actually justify a view. Circular evidence (the
   *  market's own price) gets a hollow dot and dimmer label: real, but it
   *  can't argue with itself. Weight, not hue. */
  filled: boolean;
  rows: ReturnType<typeof allSignals>;
  dead: Set<EventId> | null;
  activeId: EventId | null;
  onToggle: (eventId: EventId, label: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${filled ? "bg-bright" : "border border-hair2"}`}
        />
        <span className={`text-2xs font-mono uppercase tracking-widest ${filled ? "text-bright" : "text-dim"}`}>
          {label} ({rows.length})
        </span>
      </div>
      <p className="mb-2 text-xs text-dim">{hint}</p>
      <div className="flex flex-col divide-y divide-hair rounded-sm border border-hair">
        {rows.length === 0 && (
          <div className="px-3 py-2.5 text-xs text-dim">None captured yet.</div>
        )}
        {rows.map(({ event, signal }) => {
          const isDead = dead?.has(event.id) ?? false;
          const isActive = activeId === event.id;
          return (
            <button
              key={event.id}
              onClick={() => onToggle(event.id, signal.label)}
              className={`flex items-center justify-between gap-3 px-3 py-2 text-left transition-opacity hover:bg-panel2 ${
                isDead ? "opacity-35" : ""
              } ${isActive ? "shadow-[inset_2px_0_0_#f5f5f5]" : ""}`}
            >
              <div className="min-w-0">
                <div className={`truncate text-xs text-bright ${isDead ? "line-through" : ""}`}>
                  {signal.label}
                </div>
                <div className="truncate text-2xs text-dim">{signal.source}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!!signal.staleness && signal.staleness > 30 && (
                  <Chip weight="outlined">{signal.staleness}s old</Chip>
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
