"use client";

import { useState, useMemo } from "react";
import type { RecordedEvent, AgentRole } from "@arena/core/blackbox.js";
import { AGENTS, beliefTimeline, type TimelinePoint } from "@/lib/derive";
import { Panel, Pct } from "./ui";

/** Seven lines on one chart still need to be tellable apart, and a text
 *  label alone doesn't help inside an SVG with overlapping paths — but the
 *  distinction can be grayscale weight + dash pattern instead of hue, which
 *  is what this ladder is. Indexed by position in AGENTS, not by role, so
 *  it stays correct if the roster ever changes. */
const LINE_STYLES: { stroke: string; dash?: string }[] = [
  { stroke: "#f5f5f5" },
  { stroke: "#8a8a8a" },
  { stroke: "#b8b8b8" },
  { stroke: "#f5f5f5", dash: "6 3" },
  { stroke: "#8a8a8a", dash: "6 3" },
  { stroke: "#b8b8b8", dash: "6 3" },
  { stroke: "#f5f5f5", dash: "1.5 3" },
];
function lineStyle(agent: AgentRole): { stroke: string; dash?: string } {
  const i = AGENTS.indexOf(agent);
  // `i % LINE_STYLES.length` is always in [0, length) by construction —
  // noUncheckedIndexedAccess can't see that, hence the assertion rather
  // than a fallback that would silently mask a real out-of-bounds bug.
  return LINE_STYLES[i % LINE_STYLES.length]!;
}

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
            <line x1={PAD_L} x2={W - PAD_R} y1={y(p)} y2={y(p)} stroke="#262626" strokeWidth={1} />
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
          stroke="#363636"
          strokeWidth={1}
          strokeDasharray="2 3"
        />

        {series.map(({ agent, points }) => {
          const shown = points.filter((pt) => pt.seq <= nowSeq);
          if (!shown.length) return null;
          const dim = focusAgent !== null && focusAgent !== agent;
          const { stroke, dash } = lineStyle(agent);
          const d = shown.map((pt, i) => `${i === 0 ? "M" : "L"} ${x(pt.seq)} ${y(pt.p)}`).join(" ");
          // shown.length is checked non-zero above, so this index is always valid.
          const last = shown[shown.length - 1]!;
          return (
            <g key={agent} opacity={dim ? 0.18 : 1}>
              <path d={d} fill="none" stroke={stroke} strokeWidth={dim ? 1 : 1.5} strokeDasharray={dash} />
              {shown.map((pt) => (
                <circle
                  key={pt.eventId}
                  cx={x(pt.seq)}
                  cy={y(pt.p)}
                  r={picked?.eventId === pt.eventId ? 4.5 : 3}
                  fill={stroke}
                  stroke="#0a0a0a"
                  strokeWidth={1}
                  className="cursor-pointer"
                  onClick={() => setPicked(picked?.eventId === pt.eventId ? null : pt)}
                />
              ))}
              {!dim && (
                <text
                  x={x(last.seq) + 6}
                  y={y(last.p) + 3}
                  fontSize={9}
                  fontFamily="ui-monospace"
                  fill={stroke}
                >
                  {agent}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {picked ? (
        <div className="mt-3 rounded-md border border-hair p-3">
          <div className="mb-1.5 flex items-center gap-2 text-2xs font-mono uppercase tracking-wide">
            <span className="font-semibold text-bright">{picked.belief.agent}</span>
            <span className="text-dim">·</span>
            {picked.kind === "revised" && picked.from !== undefined ? (
              <span className="text-mid">
                <Pct v={picked.from} /> → <Pct v={picked.p} className="text-bright" />
              </span>
            ) : (
              <Pct v={picked.p} className="text-bright" />
            )}
          </div>
          <p className="text-xs text-dim">
            <span className="text-mid">Because:</span> {picked.because}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-xs text-dim">Click a point to see what caused it.</p>
      )}
    </Panel>
  );
}
