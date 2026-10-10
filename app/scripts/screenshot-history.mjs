/**
 * Match history and results screenshots (prompt C: P2B-01/03/04/06/07), on dev fixtures.
 *   PW=/path/to/playwright-core BASE=http://localhost:3217 node scripts/screenshot-history.mjs [name,name]
 * Writes docs/screens/history-<name>-<1920|390>.png (needs NEXT_PUBLIC_DEV_WALLET=1).
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
const BASE = process.env.BASE ?? "http://localhost:3217";
const only = process.argv[2]?.split(",");

const shots = [
  // P2B-03: All Matches, both games, page 1 and 2, one game.
  { name: "all-matches", route: "/matches?dev=demo" },
  { name: "all-matches-page-2", route: "/matches?page=2&dev=demo", sizes: ["1920"] },
  { name: "all-matches-holdem", route: "/matches?game=holdem&dev=demo", sizes: ["390"] },
  // P2B-04 + P2B-03 + P2B-07: Recent Matches with a backed loss, See all, Top scores today.
  { name: "game-block-puzzle", route: "/play/block-puzzle?dev=demo" },
  // P2B-07 error state: the list route fails, signed out.
  { name: "game-top-scores-error", route: "/play/block-puzzle?dev=out", failLists: true, sizes: ["1920"], wait: 9000 },
  // P2B-04: the Result screen of a backed loss (unchanged copy, for comparison with the rows).
  { name: "result-backed-lost", route: "/design/result?case=backed-lost&dev=demo", sizes: ["1920"] },
  // P2B-06: the win overlay shows under next dev (StrictMode), with its Continue button focused.
  { name: "result-won-overlay", route: "/design/result?case=won&dev=demo", wait: 1200, viewportOnly: true, sizes: ["1920", "390"] },
  // P2B-01: the Hold'em hand log drawer, open.
  { name: "holdem-hand-log", route: "/design/table?dev=demo", openLog: true, sizes: ["1920", "390"] },
];
const SIZES = { 1920: [1920, 1200], 390: [390, 844] };

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
for (const s of shots) {
  if (only && !only.includes(s.name)) continue;
  for (const sz of s.sizes ?? ["1920", "390"]) {
    const [w, h] = SIZES[sz];
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    if (s.failLists) await page.route("**/api/chain/accounts**", (r) => r.fulfill({ status: 503, body: "upstream down" }));
    await page.goto(BASE + s.route, { waitUntil: "load", timeout: 180000 });
    await page.waitForTimeout(s.wait ?? 5000);
    if (s.openLog) {
      await page.locator(".hdx-log summary").click();
      await page.waitForTimeout(300);
    }
    if (s.scrollTo) {
      await page.locator(s.scrollTo).scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => document.fonts.ready);
    const file = `${OUT}/history-${s.name}-${sz}.png`;
    await page.screenshot({ path: file, fullPage: !s.viewportOnly });
    console.log(file);
    await ctx.close();
  }
}
await browser.close();
