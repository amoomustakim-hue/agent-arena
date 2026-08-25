"use client";

import { useState, useMemo } from "react";
import type { RecordedEvent, AgentRole } from "@arena/core/blackbox.js";
import { AGENTS, beliefTimeline, type TimelinePoint } from "@/lib/derive";
import { AGENT_COLOR, Panel, Pct } from "./ui";

const W = 760;
const H = 200;
const PAD_L = 34;
const PAD_R = 12;
const PAD_T = 14;
const PAD_B = 20;

export default function BeliefTimeline({
  all,
  visible,
  focusAgent,
}: {
  /** The FULL session — the chart's x-axis domain never shrinks as you scrub,
   *  so the scrubber moves a "now" line across a fixed timeline rather than
   *  the axis itself jumping around. */
  all: RecordedEvent[];
  visible: RecordedEvent[];
  focusAgent: AgentRole | null;
}) {
  const [picked, setPicked] = useState<TimelinePoint | null>(null);

  const seqDomain = useMemo(() => {
    const seqs = all.map((e) => e.seq);
    return [Math.min(...seqs), Math.max(...seqs)] as const;
  }, [all]);
  const nowSeq = visible.length ? Math.max(...visible.map((e) => e.seq)) : seqDomain[0];

  const x = (seq: number) =>
    PAD_L + ((seq - seqDomain[0]) / Math.max(1, seqDomain[1] - seqDomain[0])) * (W - PAD_L - PAD_R);
  const y = (p: number) => PAD_T + (1 - p) * (H - PAD_T - PAD_B);

  const series = useMemo(
    () =>
      AGENTS.map((agent) => ({
        agent,
        points: beliefTimeline(all, agent),
      })),
    [all],
  );

  return (
    <Panel eyebrow="Exhibit 03" title="Belief timeline">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Agent belief timeline">
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <g key={p}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(p)} y2={y(p)} stroke="#1b2431" strokeWidth={1} />
            <text x={4} y={y(p) + 3} className="fill-dim" fontSize={9} fontFamily="ui-monospace">
              {Math.round(p * 100)}
            </text>
          </g>
        ))}

        {/* "now" line — where the replay scrubber currently sits */}
        <line
          x1={x(nowSeq)}
          x2={x(nowSeq)}
          y1={PAD_T}
          y2={H - PAD_B}
          stroke="#273347"
          strokeWidth={1}
          strokeDasharray="2 3"
        />

        {series.map(({ agent, points }) => {
          const shown = points.filter((pt) => pt.seq <= nowSeq);
          if (!shown.length) return null;
          const dim = focusAgent !== null && focusAgent !== agent;
          const color = AGENT_COLOR[agent];
          const d = shown.map((pt, i) => `${i === 0 ? "M" : "L"} ${x(pt.seq)} ${y(pt.p)}`).join(" ");
          return (
            <g key={agent} opacity={dim ? 0.18 : 1}>
              <path d={d} fill="none" stroke={color} strokeWidth={dim ? 1 : 1.5} />
              {shown.map((pt) => (
                <circle
                  key={pt.eventId}
                  cx={x(pt.seq)}
                  cy={y(pt.p)}
                  r={picked?.eventId === pt.eventId ? 4.5 : 3}
                  fill={color}
                  stroke="#05070b"
                  strokeWidth={1}
                  className="cursor-pointer"
                  onClick={() => setPicked(picked?.eventId === pt.eventId ? null : pt)}
                />
              ))}
            </g>
          );
        })}
      </svg>

      {picked ? (
        <div className="mt-2 rounded-sm border border-hair p-2.5">
          <div className="mb-1 flex items-center gap-2 text-2xs font-mono uppercase tracking-wide">
            <span style={{ color: AGENT_COLOR[picked.belief.agent] }}>{picked.belief.agent}</span>
            <span className="text-dim">·</span>
            {picked.kind === "revised" && picked.from !== undefined ? (
              <span className="text-mid">
                <Pct v={picked.from} /> → <Pct v={picked.p} className="text-bright" />
              </span>
            ) : (
              <Pct v={picked.p} className="text-bright" />
            )}
          </div>
          <p className="text-2xs text-dim">
            <span className="text-mid">Because:</span> {picked.because}
          </p>
        </div>
      ) : (
        <p className="mt-2 text-2xs text-dim">Click a point to see what caused it.</p>
      )}
    </Panel>
  );
}
