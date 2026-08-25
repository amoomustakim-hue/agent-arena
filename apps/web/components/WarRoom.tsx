"use client";

import { useState, useMemo } from "react";
import type { RecordedEvent, AgentRole } from "@arena/core/blackbox.js";
import { eventsAt } from "@/lib/derive";
import MarketHeader from "./MarketHeader";
import ReplayScrubber from "./ReplayScrubber";
import AgentRoster from "./AgentRoster";
import BeliefTimeline from "./BeliefTimeline";
import EvidencePanel from "./EvidencePanel";
import DebateFeed from "./DebateFeed";
import VerdictTicket from "./VerdictTicket";

/**
 * The whole war room is a projection of `events` at one `seq` — replay is
 * just changing which prefix of the log every panel reads. Nothing here
 * holds independent state; the scrubber is the only source of truth.
 */
export default function WarRoom({ events }: { events: RecordedEvent[] }) {
  const maxSeq = events.length ? Math.max(...events.map((e) => e.seq)) : 0;
  const [seq, setSeq] = useState(maxSeq);
  const [focusAgent, setFocusAgent] = useState<AgentRole | null>(null);

  const visible = useMemo(() => eventsAt(events, seq), [events, seq]);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5 px-5 py-6">
      <MarketHeader all={events} visible={visible} />
      <ReplayScrubber all={events} seq={seq} onChange={setSeq} />
      <AgentRoster visible={visible} onSelect={setFocusAgent} selected={focusAgent} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-5">
          <BeliefTimeline all={events} visible={visible} focusAgent={focusAgent} />
          <DebateFeed visible={visible} />
        </div>
        <div className="flex flex-col gap-5">
          <EvidencePanel visible={visible} />
          <VerdictTicket visible={visible} />
        </div>
      </div>

      <footer className="border-t border-hair pt-4 text-2xs text-dim">
        A single recorded session, replayed from its own event log — this is what "Prediction Black
        Box" means in practice: everything above is derived from{" "}
        <code className="text-mid">fixtures/session.jsonl</code>, nothing is hand-placed per screen.
      </footer>
    </div>
  );
}
