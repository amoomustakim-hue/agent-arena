import type { AgentStats } from "@/lib/reputation";

const W = 280;
const H = 280;
const PAD = 28;

/** Predicted-vs-actual scatter. A perfectly calibrated agent traces the
 *  diagonal; distance from it IS the miscalibration Murphy's decomposition
 *  reports as `reliability`. */
export default function CalibrationChart({ buckets }: { buckets: AgentStats["calibration"] }) {
  const s = (v: number) => PAD + v * (W - PAD * 2);
  const y = (v: number) => H - PAD - v * (H - PAD * 2);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[280px]" role="img" aria-label="Calibration chart">
      {/* diagonal — perfect calibration */}
      <line x1={s(0)} y1={y(0)} x2={s(1)} y2={y(1)} stroke="#273347" strokeWidth={1} strokeDasharray="3 3" />
      {/* axes */}
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#1b2431" strokeWidth={1} />
      <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#1b2431" strokeWidth={1} />
      <text x={W / 2} y={H - 6} textAnchor="middle" fontSize={9} fontFamily="ui-monospace" fill="#5d6b80">
        predicted
      </text>
      <text
        x={10}
        y={H / 2}
        textAnchor="middle"
        fontSize={9}
        fontFamily="ui-monospace"
        fill="#5d6b80"
        transform={`rotate(-90 10 ${H / 2})`}
      >
        actual
      </text>

      {buckets.map((b) => (
        <g key={b.predicted}>
          <circle
            cx={s(b.predicted)}
            cy={y(b.actual)}
            r={Math.max(3, Math.min(10, Math.sqrt(b.count)))}
            fill="#2ee6a8"
            fillOpacity={0.35}
            stroke="#2ee6a8"
            strokeWidth={1}
          />
        </g>
      ))}
    </svg>
  );
}
