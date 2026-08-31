"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

/** Nav-bar wallet chip. Connecting proves nothing by itself — it's just an
 *  address in the browser's wallet extension — the actual proof of control
 *  happens per-action, in useWalletIdentity, when something needs a real
 *  signature (currently: forking an agent). */
export default function ConnectWallet() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button
        onClick={() => disconnect()}
        title="Disconnect"
        className="rounded-sm border border-indep/40 px-2 py-0.5 font-mono text-2xs text-indep hover:bg-indep/10"
      >
        {short(address)}
      </button>
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
