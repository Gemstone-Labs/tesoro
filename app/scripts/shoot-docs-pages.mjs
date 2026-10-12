/**
 * Screenshots of the Docs pages: desktop 1440 and phone 390, dark and light.
 *   PW=/path/to/playwright-core BASE=http://localhost:3216 node scripts/shoot-docs-pages.mjs [slug,slug] [--full]
 * Writes docs/screens/docs-v2-<slug>-<dark|light>-<1440|390>.png and prints any horizontal overflow at 390.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
const BASE = process.env.BASE ?? "http://localhost:3216";
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith("--"))?.split(",");
const modes = (args.find((a) => a.startsWith("--theme="))?.slice(8) ?? "dark,light").split(",");
const PAGES = ["", "how-it-works", "accounts", "positions", "gemas", "matches", "backing", "leaderboard", "fees", "chains", "fairness", "risks", "developers", "developers/programs", "developers/settlement", "developers/rollups", "developers/cross-chain"];
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
for (const p of PAGES) {
  const slug = p === "" ? "index" : p.replace("/", "-");
  if (only && !only.includes(slug)) continue;
  for (const theme of modes) {
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      await ctx.addInitScript((t) => localStorage.setItem("tesoro-landing-theme", t), theme);
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push(e.message));
      await page.goto(`${BASE}/docs${p ? "/" + p : ""}`, { waitUntil: "load", timeout: 240000 });
      await page.waitForTimeout(1200);
      await page.evaluate(() => document.fonts.ready);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (w === 390 && over > 0) console.log("OVERFLOW", slug, theme, over);
      if (errs.length) console.log("ERR", slug, errs[0]);
      await page.screenshot({ path: `${OUT}/docs-v2-${slug}-${theme}-${w}.png`, fullPage: true });
      await ctx.close();
    }
  }
  console.log("done", p || "index");
}
await browser.close();
