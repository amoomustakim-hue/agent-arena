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
  transpilePackages: ["@arena/core", "@arena/market"],

  webpack: (config) => {
    // Those packages are NodeNext ESM: internal imports are written with a
    // `.js` extension that must resolve to the `.ts` source on disk.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

module.exports = nextConfig;
