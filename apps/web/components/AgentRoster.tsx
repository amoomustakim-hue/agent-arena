"use client";

import type { RecordedEvent, AgentRole } from "@arena/core/blackbox.js";
import { currentBelief, revisionCount, AGENTS } from "@/lib/derive";
import { AGENT_COLOR, AGENT_ROLE_LABEL, Panel, Pct } from "./ui";

export default function AgentRoster({
  visible,
  onSelect,
  selected,
}: {
  visible: RecordedEvent[];
  onSelect: (a: AgentRole | null) => void;
  selected: AgentRole | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {AGENTS.map((agent) => {
        const belief = currentBelief(visible, agent);
        const color = AGENT_COLOR[agent];
        const revisions = revisionCount(visible, agent);
        const isSelected = selected === agent;
        return (
          <button
            key={agent}
            onClick={() => onSelect(isSelected ? null : agent)}
            className="text-left"
          >
            <Panel
              className="h-full transition-shadow"
              style={isSelected ? { boxShadow: `0 0 0 1px ${color}, 0 0 0 1px #1b2431 inset` } : undefined}
            >
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span
                    className="text-2xs font-mono uppercase tracking-widest"
                    style={{ color }}
                  >
                    {agent}
                  </span>
                  {revisions > 0 && (
                    <span className="text-2xs font-mono text-dim">{revisions}×revised</span>
                  )}
                </div>
                <div className="text-2xl font-semibold text-bright">
                  {belief ? <Pct v={belief.p} /> : <span className="text-dim">—</span>}
                </div>
                {belief?.movedFrom !== undefined && (
                  <div className="text-2xs font-mono text-dim">
                    was <Pct v={belief.movedFrom} className="text-mid" />
                  </div>
                )}
                {belief?.heldAt && (
                  <div className="text-2xs font-mono text-dim">held under challenge</div>
                )}
                <div className="text-2xs uppercase tracking-wide text-dim">
                  {AGENT_ROLE_LABEL[agent]}
                </div>
              </div>
            </Panel>
          </button>
        );
      })}
    </div>
  );
}
