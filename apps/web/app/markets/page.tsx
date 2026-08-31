"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getHealth, listMarkets, startCouncil, type MarketSummary, type HealthStatus } from "@/lib/api";
import { Panel } from "@/components/ui";

export default function MarketsPage() {
  const router = useRouter();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [markets, setMarkets] = useState<MarketSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [h, m] = await Promise.all([getHealth(), listMarkets({ max: 10 })]);
        if (cancelled) return;
        setHealth(h);
        setMarkets(m.markets);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    // Windows are as short as 15 minutes and headroom shrinks every second —
    // a list that never refreshes would send you to start a council on a
    // market that's gone TOO LATE by the time you click it.
    const id = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const start = async (marketId: string) => {
    setStarting(marketId);
    setError(null);
    try {
      const { sessionId } = await startCouncil(marketId);
      router.push(`/session/${sessionId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-5 px-5 py-6">
      <header className="border-b border-hair pb-4">
        <div className="flex items-center gap-2 text-2xs font-mono uppercase tracking-widest text-dim">
          <Link href="/" className="hover:text-mid">
            Agent Arena
          </Link>
          <span>·</span>
          <span>Convene a council</span>
        </div>
        <h1 className="mt-1 text-xl font-semibold text-bright">Live event contracts</h1>
        <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-dim">
          Pulled from the intelligence server against the real Somnia testnet. Starting a council
          spawns the debate immediately — bull, bear, forensics, adversarial, risk, and judge, in
          real time, against this specific contract.
        </p>
      </header>

      {health && !health.llm.ready && (
        <div className="rounded-sm border border-material/40 bg-material/10 px-3 py-2 text-2xs text-material">
          <strong className="font-mono uppercase tracking-wide">
            No {health.llm.provider} credentials
          </strong>{" "}
          — {health.llm.detail} You can still browse markets and start a session; the council
          itself will fail at the first model call until this is configured.
        </div>
      )}
      {health && health.venue !== "connected" && (
        <div className="rounded-sm border border-fatal/40 bg-fatal/10 px-3 py-2 text-2xs text-fatal">
          Intelligence server is not connected. Is the backend running with a live venue reachable?
        </div>
      )}

      {error && (
        <div className="rounded-sm border border-fatal/40 bg-fatal/10 px-3 py-2 text-2xs text-fatal">
          {error}
          {error.toLowerCase().includes("fetch") && (
            <>
              {" "}
              — is the backend up at <code>{process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}</code>?
            </>
          )}
        </div>
      )}

      {!markets && !error && <p className="text-sm text-dim">Loading live markets…</p>}
      {markets && markets.length === 0 && (
        <p className="text-sm text-dim">No active event contracts on this venue right now.</p>
      )}

      <div className="flex flex-col gap-2">
        {markets?.map((m) => (
          <Panel key={m.marketId} className={!m.hasHeadroom ? "opacity-50" : ""}>
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono font-semibold uppercase text-bright">{m.asset}</span>
                  <span className="text-dim">{m.window} window</span>
                  {!m.hasHeadroom && (
                    <span className="rounded-sm border border-hair2 px-1.5 py-0.5 font-mono text-2xs text-dim">
                      too late
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-sm text-mid">{m.question}</p>
                <p className="mt-0.5 font-mono text-2xs text-dim">
                  expires in {m.expiresIn} · {m.marketId.slice(0, 14)}…
                </p>
              </div>
              <button
                onClick={() => start(m.marketId)}
                disabled={!m.hasHeadroom || starting !== null}
                className="shrink-0 rounded-sm border border-indep/40 px-3 py-1.5 font-mono text-2xs uppercase tracking-wide text-indep transition-opacity hover:bg-indep/10 disabled:cursor-not-allowed disabled:opacity-30"
              >
                {starting === m.marketId ? "starting…" : "convene council"}
              </button>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}
