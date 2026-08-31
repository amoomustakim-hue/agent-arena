"use client";

import { useAccount, useSignMessage } from "wagmi";

export interface SignedIdentity {
  address: string;
  message: string;
  signature: string;
}

/**
 * Sign a specific, human-readable statement of intent — not a generic
 * "log in" signature. Each action gets its own message naming exactly what
 * it authorizes and when, so a signature obtained for one purpose can't be
 * replayed to justify a different one, and the backend has something
 * concrete to show a skeptical viewer of the lineage graph later ("this
 * fork's authorship was this signature, over this exact text").
 *
 * This is deliberately lighter than a full SIWE (EIP-4361) flow: proportionate
 * to what it protects today (attributing a fork), not to trade approval —
 * see forkAgentAction's comment on why the same pattern isn't yet wired to
 * anything fund-moving.
 */
export function useWalletIdentity() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  async function sign(statement: string): Promise<SignedIdentity | null> {
    if (!address) return null;
    const message = `Agent Arena\n\n${statement}\n\nWallet: ${address}\nTimestamp: ${new Date().toISOString()}`;
    try {
      const signature = await signMessageAsync({ message });
      return { address, message, signature };
    } catch {
      return null; // user rejected the signature in their wallet
    }
  }

  return { address, isConnected, sign };
}
