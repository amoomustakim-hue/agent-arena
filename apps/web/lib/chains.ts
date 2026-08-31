import { defineChain } from "viem";

/**
 * Somnia Shannon testnet, as a viem/wagmi chain definition.
 *
 * Not a chain wagmi ships built in, so it has to be defined by hand — values
 * taken from the already-verified `ec-core/src/config.ts` and `addresses.ts`
 * (the same source the trading layer's own chain client uses), not
 * re-guessed here. If Somnia's endpoints ever move — the kit's own docs warn
 * they have before — this is the one other place that needs the update.
 */
export const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://api.infra.testnet.somnia.network"] },
  },
  testnet: true,
});
