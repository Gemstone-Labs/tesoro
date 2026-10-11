// Screenshots of the divider's growth tunings (?g=1..3): docs/screens/waitlist-g{1,2,3}-{1440,390,zoom}.png.
//   BASE=http://localhost:3217 PW=<path to playwright-core> node scripts/screenshot-waitlist-growth.mjs
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PW ?? "playwright-core");
const BASE = process.env.BASE ?? "http://localhost:3217";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const [suffix, width, height, scale, clip] of [
  ["1440", 1440, 900, 1, null],
  ["390", 390, 844, 1, null],
  ["zoom", 1440, 900, 2, { x: 560, y: 250, width: 400, height: 300 }],
]) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  for (const g of [1, 2, 3]) {
    await page.goto(`${BASE}/?g=${g}`, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(2200);
    const m = await page.evaluate(() => ({ h: document.documentElement.scrollWidth - document.documentElement.clientWidth, form: Math.round(document.querySelector(".wl-form")?.getBoundingClientRect().bottom ?? 0) }));
    await page.screenshot({ path: `${OUT}/waitlist-g${g}-${suffix}.png`, ...(clip ? { clip } : {}) });
    console.log(g, suffix, "hscroll", m.h, "form bottom", m.form, "/", height);
  }
  await ctx.close();
}
await browser.close();
