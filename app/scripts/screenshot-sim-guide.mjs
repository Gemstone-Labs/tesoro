/**
 * Simulated-yield labels, Pending by Source and the corner Guide at 1320, 1024 and 390 px.
 *   PW=/path/to/playwright-core BASE=http://localhost:3241 node scripts/screenshot-sim-guide.mjs before|after
 * Writes docs/screens/simguide-<name>-<width>-<tag>.png (needs NEXT_PUBLIC_DEV_WALLET=1).
 * Wallet shots are full page with "Pending by Source" open; Guide shots are the viewport scrolled to
 * the bottom, where the bubble meets the page content.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
const BASE = process.env.BASE ?? "http://localhost:3241";
const tag = process.argv[2] ?? "after";

const shots = [
  { name: "wallet", route: "/wallet?dev=demo", full: true, openPending: true },
  { name: "guide-wallet", route: "/wallet?dev=demo", bottom: true, openGuide: true },
  { name: "guide-lobby", route: "/?dev=demo", bottom: true, openGuide: true },
  { name: "guide-backing", route: "/backing?dev=demo", bottom: true, openGuide: true },
];
const sizes = [
  [1320, 860],
  [1024, 768],
  [390, 844],
];

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
for (const s of shots) {
  for (const [w, h] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.goto(BASE + s.route, { waitUntil: "load", timeout: 180000 });
    await page.waitForTimeout(5000);
    // the Next dev-tools badge sits bottom-left too; it is not part of the app
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    if (s.openPending) await page.locator("details.wl-pbs > summary").click().catch(() => undefined);
    if (s.openGuide && w < 1024) await page.locator(".guide-chip").click().catch(() => undefined);
    if (s.bottom) await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(600);
    await page.evaluate(() => document.fonts.ready);
    const file = `${OUT}/simguide-${s.name}-${w}-${tag}.png`;
    if (s.full) {
      // grow the viewport to the page so fixed chrome (bottom nav, Guide) sits at the real bottom
      const full = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width: w, height: full });
      await page.waitForTimeout(600);
    }
    await page.screenshot({ path: file });
    console.log("wrote", file);
    await ctx.close();
  }
}
await browser.close();
