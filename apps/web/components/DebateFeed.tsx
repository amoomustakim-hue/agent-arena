"use client";

import type { RecordedEvent } from "@arena/core/blackbox.js";
import { AGENT_COLOR, SEVERITY_COLOR, Panel, Pct } from "./ui";

/** A challenge, plus whatever it caused (a revision or a held-ground), if
 *  that response has happened by the current seq — so the feed shows the
 *  attack and the outcome as one unit once both exist. */
export default function DebateFeed({ visible }: { visible: RecordedEvent[] }) {
  const challenges = visible.filter((e): e is Extract<RecordedEvent, { kind: "challenge_issued" }> => e.kind === "challenge_issued");

  type Response = Extract<RecordedEvent, { kind: "belief_revised" | "belief_held" }>;
  const responseFor = (challengeId: string): Response | undefined =>
    visible.find(
      (e): e is Response =>
        (e.kind === "belief_revised" || e.kind === "belief_held") && e.causedBy.includes(challengeId),
    );

  return (
    <Panel eyebrow="The debate" title={`${challenges.length} challenge${challenges.length === 1 ? "" : "s"} issued`}>
      <div className="flex flex-col gap-3">
        {challenges.length === 0 && <div className="text-2xs text-dim">— no challenges yet —</div>}
        {challenges.map((c) => {
          const response = responseFor(c.id);
          const sevColor = SEVERITY_COLOR[c.severity];
          return (
            <div key={c.id} className="rounded-sm border border-hair p-3">
              <div className="mb-1.5 flex items-center gap-2 text-2xs font-mono uppercase tracking-wide">
                <span style={{ color: AGENT_COLOR[c.from] }}>{c.from}</span>
                <span className="text-dim">→</span>
                <span style={{ color: AGENT_COLOR[c.against] }}>{c.against}</span>
                <span
                  className="ml-auto rounded-sm border px-1.5 py-0.5"
                  style={{ borderColor: `${sevColor}55`, color: sevColor }}
                >
                  {c.severity}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-mid">{c.claim}</p>

              {response && (
                <div className="mt-2 border-t border-hair pt-2">
                  {response.kind === "belief_revised" ? (
                    <div className="flex items-center gap-2 text-xs">
                      <span style={{ color: AGENT_COLOR[response.belief.agent] }} className="font-mono uppercase text-2xs">
                        {response.belief.agent}
                      </span>
                      <span className="text-indep">revised</span>
                      <Pct v={response.from} className="text-dim" />
                      <span className="text-dim">→</span>
                      <Pct v={response.belief.p} className="text-bright" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs">
                      <span style={{ color: AGENT_COLOR[response.agent] }} className="font-mono uppercase text-2xs">
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
