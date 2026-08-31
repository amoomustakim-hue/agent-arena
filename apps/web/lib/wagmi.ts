import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { somniaTestnet } from "./chains";

/**
 * `injected()` only — the browser-extension wallet path (MetaMask, Rabby,
 * etc.), not full WalletConnect's QR/mobile flow. This is a deliberate scope
 * cut: what a wallet connection is actually FOR here is turning "who forked
 * this agent" and (later) "who approved this trade" from a free-text field
 * into a real signature, which an injected wallet proves exactly as well as
 * WalletConnect does. WalletConnect would add mobile/QR support at the cost
 * of a project id, a relay dependency, and more surface that can fail live
 * on stage — not worth it for what this needs to prove.
 */
export const wagmiConfig = createConfig({
  chains: [somniaTestnet],
  connectors: [injected()],
  transports: {
    [somniaTestnet.id]: http(),
  },
});
