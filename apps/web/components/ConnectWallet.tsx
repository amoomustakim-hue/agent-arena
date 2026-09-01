"use client";

import Link from "next/link";
import { useAccount, useConnect } from "wagmi";

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

/** Nav-bar wallet chip. Connecting proves nothing by itself — it's just an
 *  address in the browser's wallet extension — the actual proof of control
 *  happens per-action, in useWalletIdentity, when something needs a real
 *  signature (currently: forking an agent). Once connected this links to
 *  /wallet (network check, disconnect, this address's forks) rather than
 *  disconnecting on click — a nav chip is for getting somewhere, not for
 *  a destructive action with no confirmation. */
export default function ConnectWallet() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();

  if (isConnected && address) {
    return (
      <Link
        href="/wallet"
        title="View wallet"
        className="rounded-sm border border-indep/40 px-2 py-0.5 font-mono text-2xs text-indep hover:bg-indep/10"
      >
        {short(address)}
      </Link>
    );
  }

  const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];

  return (
    <button
      onClick={() => injected && connect({ connector: injected })}
      disabled={isPending || !injected}
      title={injected ? "Connect a browser wallet" : "No browser wallet detected (install MetaMask or similar)"}
      className="rounded-sm border border-hair px-2 py-0.5 font-mono text-2xs text-dim hover:border-hair2 hover:text-mid disabled:cursor-not-allowed disabled:opacity-40"
    >
      {isPending ? "connecting…" : injected ? "connect wallet" : "no wallet found"}
    </button>
  );
}

export { short };
