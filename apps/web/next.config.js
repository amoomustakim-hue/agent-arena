const { join } = require("node:path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Next infers the workspace root by walking up for the nearest lockfile,
  // and picks up an unrelated `pnpm-lock.yaml` that happens to sit in the
  // Windows user profile directory above this repo — pin it explicitly so
  // the build never depends on what else exists on this machine.
  outputFileTracingRoot: join(__dirname, "..", ".."),

  // The workspace packages ship raw TypeScript (their `exports` map points at
  // `src/*.ts`), so Next has to compile them rather than treat them as built
  // deps. `@arena/core/blackbox.js` is the Black Box itself — pure, dependency
  // free, and safe to run in the browser.
  transpilePackages: ["@arena/core", "@arena/market", "@arena/reputation"],

  webpack: (config) => {
    // Those packages are NodeNext ESM: internal imports are written with a
    // `.js` extension that must resolve to the `.ts` source on disk.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };

    // wagmi's connector barrel (`wagmi/connectors`) re-exports every
    // connector type it ships, not just the one this app imports
    // (`injected()`, lib/wagmi.ts) — so webpack's build-time trace still
    // walks into @wagmi/connectors' Coinbase "Base Account" connector,
    // which pulls in @base-org/account and @coinbase/cdp-sdk, which in turn
    // reference a handful of @x402/* payment-protocol packages this project
    // never installs and has no use for. Aliasing one @x402 path at a time
    // as each surfaced turned into whack-a-mole (evm, then svm/exact/client,
    // ...) — cutting off the two top-level packages that pull the whole
    // x402 branch in is the fix that doesn't need updating every time a new
    // sub-path shows up.
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@coinbase/cdp-sdk": false,
      "@base-org/account": false,
    };
    return config;
  },
};

module.exports = nextConfig;
