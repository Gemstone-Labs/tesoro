/**
 * Screenshots of the three rebuilt screens (Match result, Wallet, Backing) at 1920x1200 and 390x844.
 * Needs a dev server with NEXT_PUBLIC_DEV_WALLET=1 and playwright-core:
 *
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3110 node scripts/screenshot-p2.mjs [name,name]
 *
 * Wallet and Backing use the ?dev=demo fixtures; the result uses /design/result?case=... fixtures.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE ?? "http://localhost:3110";

const shots = [
  { name: "result-won", route: "/design/result?case=won&dev=demo" },
  { name: "result-lost", route: "/design/result?case=lost&dev=demo" },
  { name: "result-draw", route: "/design/result?case=draw&dev=demo" },
  { name: "result-backed-player", route: "/design/result?case=backed-player&dev=demo" },
  { name: "result-backer-won", route: "/design/result?case=backer-won&dev=demo" },
  { name: "result-holdem-won", route: "/design/result?case=holdem-won&dev=demo" },
  { name: "wallet", route: "/wallet?dev=demo" },
  { name: "wallet-eth-tab", route: "/wallet?dev=demo", act: async (p) => p.getByRole("button", { name: "Open an ETH Position" }).first().click() },
  { name: "backing", route: "/backing?dev=demo" },
  { name: "backing-offer", route: "/backing?dev=demo", act: async (p) => p.getByRole("button", { name: "Make an Offer" }).first().click() },
  { name: "backing-list", route: "/backing?dev=demo", act: async (p) => p.getByRole("button", { name: "List view" }).click() },
];
const sizes = [
  [1920, 1200, "1920"],
  [390, 844, "390"],
];
const only = process.argv[2]?.split(",");

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
for (const s of shots) {
  if (only && !only.includes(s.name)) continue;
  for (const [w, h, tag] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${s.route}`, { waitUntil: "load", timeout: 180000 });
    await page.waitForTimeout(4500);
    if (s.act) {
      await s.act(page).catch((e) => console.log("act failed", s.name, e.message.split("\n")[0]));
      await page.waitForTimeout(800);
    }
    await page.evaluate(() => document.fonts.ready);
    const file = `${OUT}/p2-${s.name}-${tag}.png`;
    await page.screenshot({ path: file, fullPage: w < 1000 });
    console.log("wrote", file);
    await ctx.close();
  }
}
await browser.close();
