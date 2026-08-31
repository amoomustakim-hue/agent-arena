// Browser-driven verification of the actual rendered app — not a typecheck,
// not a curl, an actual Chromium tab. This is how two real bugs were found
// that every other check (tsc, TestClient, raw WebSocket scripts) missed:
// Python's market_observed event was missing fields MarketHeader.tsx reads
// directly (`new Date(undefined * 1000)` -> NaN -> "Invalid time value" the
// moment a live session rendered its first event), and an HTML `pattern`
// attribute regex that Chromium's newer parser rejects outright. Neither
// shows up unless something actually paints in a browser.
//
// Requires both servers already running (see repo README) and Playwright's
// Chromium installed once: `pnpm exec playwright install chromium`.
//
//   node apps/web/scripts/browser-check.mjs
//
// Screenshots land next to this file's caller in ./screenshots/.

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "screenshots");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

async function shot(name) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
  console.log(`  -> ${name}.png`);
}

console.log("=== / (static fixture war room) ===");
await page.goto("http://localhost:3100/", { waitUntil: "networkidle" });
await page.waitForSelector("text=Agent Arena", { timeout: 15000 });
await shot("01-warroom-fixture");

console.log("\n=== /markets ===");
await page.goto("http://localhost:3100/markets", { waitUntil: "networkidle" });
await page.waitForSelector("text=Live event contracts", { timeout: 15000 });
await page.waitForTimeout(1500); // let the client-side fetch resolve
await shot("02-markets");

console.log("\n=== start a real council, if one has headroom ===");
const conveneBtn = page.locator("button:has-text('convene council')").first();
if (await conveneBtn.count()) {
  await conveneBtn.click();
  await page.waitForURL(/\/session\//, { timeout: 15000 });
  console.log("  redirected to:", page.url());
  await page.waitForTimeout(6000);
  await shot("03-session-live");
} else {
  console.log("  no tradeable market right now — skipping");
}

console.log("\n=== /reputation/bull — wallet + fork UI ===");
await page.goto("http://localhost:3100/reputation/bull", { waitUntil: "networkidle" });
await page.waitForSelector("text=BULL", { timeout: 15000 });
await shot("04-agent-profile");

console.log("\n=== console errors captured ===");
if (errors.length) errors.forEach((e) => console.log("  ERROR:", e));
else console.log("  none");

await browser.close();
console.log("\ndone.");
if (errors.length) process.exit(1);
