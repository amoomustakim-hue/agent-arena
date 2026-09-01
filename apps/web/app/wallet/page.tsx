"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import type { AgentVersion } from "@arena/reputation";
import { somniaTestnet } from "@/lib/chains";
import { getForksByWallet } from "@/lib/lineage-actions";
import { Panel } from "@/components/ui";

export default function WalletPage() {
  const { address, isConnected, isConnecting } = useAccount();
  const { connect, connectors, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain, isPending: switching } = useSwitchChain();

  const [forks, setForks] = useState<AgentVersion[] | null>(null);
  const [copied, setCopied] = useState(false);

  const wrongChain = isConnected && chainId !== somniaTestnet.id;

  useEffect(() => {
    if (!address) {
      setForks(null);
      return;
    }
    let cancelled = false;
    getForksByWallet(address).then((f) => {
      if (!cancelled) setForks(f);
    });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];

  const copyAddress = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mx-auto flex max-w-[800px] flex-col gap-5 px-5 py-6">
      <header className="border-b border-hair pb-4">
        <div className="flex items-center gap-2 text-2xs font-mono uppercase tracking-widest text-dim">
          <Link href="/" className="hover:text-mid">
            Agent Arena
          </Link>
          <span>·</span>
          <span>Wallet</span>
        </div>
        <h1 className="mt-1 text-xl font-semibold text-bright">Your wallet</h1>
        <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-dim">
          Connecting proves nothing by itself — it&apos;s just an address sitting in a browser
          extension. What makes it real is a signature over one specific action, requested at the
          moment it&apos;s needed. Today that&apos;s forking an agent; the same signature isn&apos;t
          wired to trade approval yet, deliberately, since that&apos;s a fund-movement decision, not
          a coding one.
        </p>
      </header>

      {!isConnected ? (
        <Panel>
          <div className="flex flex-col items-start gap-3 py-2">
            <p className="text-sm text-mid">No wallet connected.</p>
            <button
              onClick={() => injected && connect({ connector: injected })}
              disabled={isConnecting || !injected}
              className="rounded-sm border border-indep/40 px-4 py-2 font-mono text-xs uppercase tracking-wide text-indep hover:bg-indep/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isConnecting ? "connecting…" : injected ? "connect wallet" : "no wallet extension found"}
            </button>
            {!injected && (
              <p className="text-2xs text-dim">
                Install a browser wallet extension (MetaMask or similar) and reload this page.
              </p>
            )}
            {connectError && <p className="text-2xs text-fatal">{connectError.message}</p>}
          </div>
        </Panel>
      ) : (
        <>
          <Panel eyebrow="Connected" title="Address">
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <span className="break-all font-mono text-sm text-bright">{address}</span>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={copyAddress}
                    className="rounded-sm border border-hair px-2.5 py-1 font-mono text-2xs uppercase text-dim hover:border-hair2 hover:text-mid"
                  >
                    {copied ? "copied" : "copy"}
                  </button>
                  <button
                    onClick={() => disconnect()}
                    className="rounded-sm border border-hair px-2.5 py-1 font-mono text-2xs uppercase text-dim hover:border-fatal/40 hover:text-fatal"
                  >
                    disconnect
                  </button>
                </div>
              </div>

              {wrongChain ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-material/40 bg-material/10 px-3 py-2">
                  <span className="text-2xs text-material">
                    Connected to chain {chainId}, not Somnia Testnet ({somniaTestnet.id}). Signed
                    forks will still work, but the address won&apos;t match what the venue itself
                    sees this wallet as.
                  </span>
                  <button
                    onClick={() => switchChain({ chainId: somniaTestnet.id })}
                    disabled={switching}
                    className="shrink-0 rounded-sm border border-material/40 px-2.5 py-1 font-mono text-2xs uppercase text-material hover:bg-material/10 disabled:opacity-40"
                  >
                    {switching ? "switching…" : "switch network"}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-2xs text-indep">
                  <span className="h-1.5 w-1.5 rounded-full bg-indep" />
                  On Somnia Testnet
                </div>
              )}
            </div>
          </Panel>

          <Panel eyebrow="Lineage" title="Agents forked by this wallet">
            {forks === null ? (
              <p className="text-2xs text-dim">Loading…</p>
            ) : forks.length === 0 ? (
              <p className="text-2xs text-dim">
                None yet. Fork an agent from any{" "}
                <Link href="/reputation" className="text-mid underline">
                  agent profile
                </Link>{" "}
                while connected to attribute it to this wallet.
              </p>
            ) : (
              <div className="flex flex-col divide-y divide-hair">
                {forks.map((f) => (
                  <div key={f.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div>
                      <Link href={`/reputation/${f.role}`} className="font-mono text-sm text-bright hover:underline">
                        {f.id}
                      </Link>
                      <div className="text-2xs text-dim">{f.displayName}</div>
                    </div>
                    <span className="font-mono text-2xs uppercase text-dim">{f.role}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
