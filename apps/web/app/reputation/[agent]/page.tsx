import Link from "next/link";
import { notFound } from "next/navigation";
import type { AgentRole } from "@arena/core";
import { loadReputation, statsFor } from "@/lib/reputation";
import { AGENT_COLOR, AGENT_ROLE_LABEL, Panel } from "@/components/ui";
import DemoBanner from "@/components/DemoBanner";
import CalibrationChart from "@/components/CalibrationChart";

const VALID: AgentRole[] = ["bull", "bear", "forensics", "adversarial", "risk", "judge", "trader"];

export function generateStaticParams() {
  return VALID.map((agent) => ({ agent }));
}

export default async function AgentProfilePage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent: raw } = await params;
  if (!VALID.includes(raw as AgentRole)) notFound();
  const agent = raw as AgentRole;

  const { records, isDemo } = await loadReputation();
  const stats = statsFor(agent, records);
  const color = AGENT_COLOR[agent];
  const skill = stats.skillVsMarket;

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-5 px-5 py-6">
      <header className="border-b border-hair pb-4">
        <div className="flex items-center gap-2 text-2xs font-mono uppercase tracking-widest text-dim">
          <Link href="/" className="hover:text-mid">
            Agent Arena
          </Link>
          <span>·</span>
          <Link href="/reputation" className="hover:text-mid">
            Reputation
          </Link>
          <span>·</span>
          <span style={{ color }}>{agent}</span>
        </div>
        <div className="mt-1 flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold uppercase tracking-wide" style={{ color }}>
            {agent}
          </h1>
          <span className="text-xs text-dim">{AGENT_ROLE_LABEL[agent]}</span>
          <button
            disabled
            title="Not wired up yet — forking exists in the reputation engine (lineage.ts), not on this page"
            className="ml-auto cursor-not-allowed rounded-sm border border-hair px-2.5 py-1 font-mono text-2xs text-dim opacity-60"
          >
            Fork agent
          </button>
        </div>
      </header>

      {isDemo && <DemoBanner />}

      {stats.predictions === 0 ? (
        <p className="text-sm text-dim">No settled predictions for this agent yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Predictions" value={String(stats.predictions)} />
            <Stat label="Brier" value={stats.brier.toFixed(4)} hint="lower is better" />
            <Stat
              label="Vs. market"
              value={skill === null ? "n/a" : `${skill >= 0 ? "+" : ""}${skill.toFixed(3)}`}
              accent={skill === null ? undefined : skill > 0.05 ? "#2ee6a8" : skill < -0.05 ? "#ff9d3d" : undefined}
              hint={skill === null ? undefined : skill > 0.05 ? "beats market" : skill < -0.05 ? "loses to market" : "matches market"}
            />
            <Stat label="Accuracy" value={`${(stats.accuracy * 100).toFixed(0)}%`} hint="reported, not ranked on" />
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Panel eyebrow="Calibration" title="Predicted vs. actual">
              <CalibrationChart buckets={stats.calibration} />
              <p className="mt-2 text-2xs text-dim">
                A perfectly calibrated agent traces the dashed diagonal. Dot size is sample count per
                bucket — buckets under 3 samples are dropped rather than shown, since one prediction
                reads as either flawless or hopeless calibration and is neither.
              </p>
            </Panel>

            <Panel eyebrow="Decomposition" title="Brier = reliability − resolution + uncertainty">
              {stats.decomposition ? (
                <div className="flex flex-col gap-3">
                  <DecompRow
                    label="Reliability"
                    value={stats.decomposition.reliability.toFixed(4)}
                    hint="Miscalibration. Lower is better."
                  />
                  <DecompRow
                    label="Resolution"
                    value={stats.decomposition.resolution.toFixed(4)}
                    hint="Discrimination. HIGHER is better — an agent that always says 50% has zero of this: never wrong, never useful."
                    warn={stats.decomposition.resolution < 0.01}
                    warnText="Near-zero resolution: this agent hugs the base rate."
                  />
                  <DecompRow
                    label="Uncertainty"
                    value={stats.decomposition.uncertainty.toFixed(4)}
                    hint="The market's own variance. Not the agent's doing."
                  />
                </div>
              ) : (
                <p className="text-2xs text-dim">Not enough settled predictions to decompose yet.</p>
              )}
            </Panel>
          </div>

          <Panel eyebrow="Intellectual honesty" title="Did revising help?">
            {stats.revisions > 0 ? (
              <p className="text-sm text-mid">
                Revised <span className="font-mono text-bright">{stats.revisions}</span> time
                {stats.revisions === 1 ? "" : "s"} under challenge;{" "}
                <span className="font-mono text-bright">{stats.revisionsHelpful}</span> of those moved
                toward the truth (
                <span className="font-mono" style={{ color: (stats.revisionQuality ?? 0) >= 0.5 ? "#2ee6a8" : "#ff9d3d" }}>
                  {((stats.revisionQuality ?? 0) * 100).toFixed(0)}%
                </span>
                ). Opening Brier {stats.brierOpening.toFixed(4)} → final {stats.brier.toFixed(4)} (
                {stats.brierOpening > stats.brier ? "debate helped" : "debate hurt"}).
              </p>
            ) : (
              <p className="text-sm text-dim">Never revised under challenge in this corpus.</p>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent, hint }: { label: string; value: string; accent?: string; hint?: string }) {
  return (
    <div className="rounded-md bg-panel p-3 shadow-panel">
      <div className="text-2xs font-mono uppercase tracking-widest text-dim">{label}</div>
      <div className="tabular mt-1 font-mono text-xl" style={{ color: accent ?? "#dce6f2" }}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-2xs text-dim">{hint}</div>}
    </div>
  );
}

function DecompRow({
  label,
  value,
  hint,
  warn,
  warnText,
}: {
  label: string;
  value: string;
  hint: string;
  warn?: boolean;
  warnText?: string;
}) {
  return (
    <div className="border-t border-hair pt-2.5 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between">
        <span className="text-2xs font-mono uppercase tracking-widest text-dim">{label}</span>
        <span className="tabular font-mono text-sm text-bright">{value}</span>
      </div>
      <p className="mt-0.5 text-2xs text-dim">{hint}</p>
      {warn && <p className="mt-0.5 text-2xs text-circ">→ {warnText}</p>}
    </div>
  );
}
