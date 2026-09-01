"use client";

import type { EventId, RecordedEvent } from "@arena/core/blackbox.js";
import { SEVERITY_WEIGHT, Panel, Chip, Pct } from "./ui";

/** A challenge, plus whatever it caused (a revision or a held-ground), if
 *  that response has happened by the current seq — so the feed shows the
 *  attack and the outcome as one unit once both exist. */
export default function DebateFeed({
  visible,
  dead,
}: {
  visible: RecordedEvent[];
  dead: Set<EventId> | null;
}) {
  const challenges = visible.filter((e): e is Extract<RecordedEvent, { kind: "challenge_issued" }> => e.kind === "challenge_issued");

  type Response = Extract<RecordedEvent, { kind: "belief_revised" | "belief_held" }>;
  const responseFor = (challengeId: string): Response | undefined =>
    visible.find(
      (e): e is Response =>
        (e.kind === "belief_revised" || e.kind === "belief_held") && e.causedBy.includes(challengeId),
    );

  return (
    <Panel eyebrow="The debate" title={`${challenges.length} challenge${challenges.length === 1 ? "" : "s"} issued`}>
      <div className="flex flex-col gap-3.5">
        {challenges.length === 0 && <div className="text-xs text-dim">No challenges yet.</div>}
        {challenges.map((c) => {
          const response = responseFor(c.id);
          const isDead = dead?.has(c.id) ?? false;
          return (
            <div
              key={c.id}
              className={`rounded-md border border-hair p-4 transition-opacity ${isDead ? "opacity-30" : ""}`}
            >
              <div className="mb-2 flex items-center gap-2 text-2xs font-mono uppercase tracking-wide text-bright">
                <span className="font-semibold">{c.from}</span>
                <span className="text-dim">→</span>
                <span className="font-semibold">{c.against}</span>
                <Chip weight={SEVERITY_WEIGHT[c.severity]} className="ml-auto lowercase">
                  {c.severity}
                </Chip>
              </div>
              <p className={`text-xs leading-relaxed text-mid ${isDead ? "line-through" : ""}`}>{c.claim}</p>
              {isDead && (
                <p className="mt-1.5 text-xs font-medium text-bright">
                  Never issued — depended on the removed evidence.
                </p>
              )}

              {response && (
                <div className="mt-2.5 border-t border-hair pt-2.5">
                  {response.kind === "belief_revised" ? (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-2xs font-semibold uppercase text-bright">
                        {response.belief.agent}
                      </span>
                      <span className="text-mid">revised</span>
                      <Pct v={response.from} className="text-dim" />
                      <span className="text-dim">→</span>
                      <Pct v={response.belief.p} className="text-bright" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-2xs font-semibold uppercase text-bright">
                        {response.agent}
                      </span>
                      <span className="text-mid">held at</span>
                      <Pct v={response.p} className="text-bright" />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
