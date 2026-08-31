import Link from "next/link";
import { loadReputation, leaderboard } from "@/lib/reputation";
import { AGENT_COLOR, AGENT_ROLE_LABEL } from "@/components/ui";
import DemoBanner from "@/components/DemoBanner";
import ConnectWallet from "@/components/ConnectWallet";

export default async function ReputationPage() {
  const { records, isDemo } = await loadReputation();
  const board = leaderboard(records);
  const sessions = new Set(records.map((r) => r.sessionId)).size;

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-5 px-5 py-6">
      <header className="border-b border-hair pb-4">
        <div className="flex items-center gap-2 text-2xs font-mono uppercase tracking-widest text-dim">
          <Link href="/" className="hover:text-mid">
            Agent Arena
          </Link>
          <span>·</span>
          <span>Reputation</span>
          <span className="ml-auto">
            <ConnectWallet />
          </span>
        </div>
        <h1 className="mt-1 text-xl font-semibold text-bright">Leaderboard</h1>
        <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-dim">
          Ranked by Brier Skill Score against the market&apos;s own price — not accuracy. These
          contracts settle close to even, so an agent that says 51% and is right scores the same as
          one that says 95% and is right. Beating the market is the only test that means anything
          here, and most agents will not.
        </p>
      </header>

      {isDemo && <DemoBanner />}

      <p className="text-2xs text-dim">
        {records.length} settled prediction{records.length === 1 ? "" : "s"} across {sessions} session
        {sessions === 1 ? "" : "s"}
      </p>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-hair text-left text-2xs font-mono uppercase tracking-widest text-dim">
            <th className="py-2 pr-3 font-medium">Agent</th>
            <th className="py-2 pr-3 font-medium">n</th>
            <th className="py-2 pr-3 font-medium">Brier</th>
            <th className="py-2 pr-3 font-medium">Vs. market</th>
            <th className="py-2 font-medium">Revisions</th>
          </tr>
        </thead>
        <tbody>
          {board.map((s) => {
            const skill = s.skillVsMarket;
            const verdict =
              skill === null ? null : skill > 0.05 ? "beats" : skill > -0.05 ? "matches" : "loses";
            return (
              <tr key={s.agent} className="border-b border-hair">
                <td className="py-2.5 pr-3">
                  <Link href={`/reputation/${s.agent}`} className="hover:underline">
                    <span
                      className="font-mono text-sm font-medium uppercase"
                      style={{ color: AGENT_COLOR[s.agent] }}
                    >
                      {s.agent}
                    </span>
                  </Link>
                  <div className="text-2xs text-dim">{AGENT_ROLE_LABEL[s.agent]}</div>
                </td>
                <td className="tabular py-2.5 pr-3 font-mono text-mid">{s.predictions}</td>
                <td className="tabular py-2.5 pr-3 font-mono text-mid">{s.brier.toFixed(4)}</td>
                <td className="py-2.5 pr-3">
                  {skill === null ? (
                    <span className="text-2xs text-dim">n/a</span>
                  ) : (
                    <span
                      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-2xs ${
                        verdict === "beats"
                          ? "border-indep/40 text-indep"
                          : verdict === "matches"
                            ? "border-hair2 text-mid"
                            : "border-circ/40 text-circ"
                      }`}
                    >
                      {skill >= 0 ? "+" : ""}
                      {skill.toFixed(3)} · {verdict} market
                    </span>
                  )}
                </td>
                <td className="py-2.5 text-2xs text-dim">
                  {s.revisions > 0
                    ? `${s.revisionsHelpful}/${s.revisions} helpful`
                    : "never revised"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="text-2xs text-dim">
        Two of four personas losing to the market on the demo corpus is the intended result — a
        leaderboard where everyone looks good would be the one worth distrusting.
      </p>
    </div>
  );
}
