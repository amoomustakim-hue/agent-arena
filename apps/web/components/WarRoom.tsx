"use client";

import { useState, useMemo, useEffect } from "react";
import type { RecordedEvent, AgentRole, EventId } from "@arena/core/blackbox.js";
import { eventsAt, counterfactual as computeCounterfactual } from "@/lib/derive";
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
 * holds independent state except the scrubber position and, in `live` mode,
 * whether it is currently following the tail.
 *
 * The counterfactual is a second, orthogonal lens on the SAME `visible`
 * prefix: it never changes what seq is showing, only which of those events
 * are marked dead. Clicking the same evidence row again clears it — a
 * toggle, not a one-way action.
 */
export default function WarRoom({
  events,
  live = false,
}: {
  events: RecordedEvent[];
  /** When true, the scrubber auto-advances to the newest event as `events`
   *  grows — a council actually debating, not a recorded session. Scrubbing
   *  backward manually drops out of follow; the scrubber's own "live edge"
   *  button re-enters it, exactly like a video player's live tail. */
  live?: boolean;
}) {
  const maxSeq = events.length ? Math.max(...events.map((e) => e.seq)) : 0;
  const [seq, setSeq] = useState(maxSeq);
  const [followLive, setFollowLive] = useState(live);
  const [focusAgent, setFocusAgent] = useState<AgentRole | null>(null);
  const [removedId, setRemovedId] = useState<EventId | null>(null);
  const [removedLabel, setRemovedLabel] = useState<string>("");

  useEffect(() => {
    if (followLive) setSeq(maxSeq);
  }, [maxSeq, followLive]);

  const handleScrub = (next: number) => {
    setSeq(next);
    setFollowLive(live && next >= maxSeq);
  };

  const visible = useMemo(() => eventsAt(events, seq), [events, seq]);

  // Computed over the full visible prefix, not just what's currently
  // rendered — removing a signal from an earlier moment in the debate should
  // still show its true downstream blast radius up to "now".
  const cf = useMemo(() => {
    if (!removedId) return null;
    const { dead, verdictSurvives } = computeCounterfactual(visible, removedId);
    return { label: removedLabel, dead, verdictSurvives };
  }, [visible, removedId, removedLabel]);

  const toggleRemove = (eventId: EventId, label: string) => {
    setRemovedId((cur) => (cur === eventId ? null : eventId));
    setRemovedLabel(label);
  };

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5 px-5 py-6">
      <MarketHeader all={events} visible={visible} />
      {live && (
        <div className="flex items-center gap-2 text-2xs font-mono uppercase tracking-widest">
          <span className={`h-1.5 w-1.5 rounded-full ${followLive ? "animate-rec bg-fatal" : "bg-hair2"}`} />
          <span className={followLive ? "text-fatal" : "text-dim"}>
            {followLive ? "live — following the debate" : "paused — scrubbed back in history"}
          </span>
        </div>
      )}
      <ReplayScrubber all={events} seq={seq} onChange={handleScrub} />
      <AgentRoster visible={visible} onSelect={setFocusAgent} selected={focusAgent} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-5">
          <BeliefTimeline all={events} visible={visible} focusAgent={focusAgent} />
          <DebateFeed visible={visible} dead={cf?.dead ?? null} />
        </div>
        <div className="flex flex-col gap-5">
          <EvidencePanel
            visible={visible}
            dead={cf?.dead ?? null}
            activeId={removedId}
            onToggle={toggleRemove}
          />
          <VerdictTicket visible={visible} counterfactual={cf} />
        </div>
      </div>

      {!live && (
        <footer className="border-t border-hair pt-4 text-2xs text-dim">
          A single recorded session, replayed from its own event log — this is what "Prediction
          Black Box" means in practice: everything above is derived from{" "}
          <code className="text-mid">fixtures/session.jsonl</code>, nothing is hand-placed per
          screen.
        </footer>
      )}
    </div>
  );
}
