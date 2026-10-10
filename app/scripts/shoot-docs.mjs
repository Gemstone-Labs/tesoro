/**
 * Screenshots for the Docs: signed-in fixture views (dev wallet, ?dev=demo) cropped to the viewport and exported as WebP.
 *   PW=/path/to/playwright-core BASE=http://localhost:3216 node scripts/shoot-docs.mjs [name,name]
 * Writes public/docs/shot-<name>.webp (needs NEXT_PUBLIC_DEV_WALLET=1). Nothing is sent on chain.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const sharp = require("sharp");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/docs");
const BASE = process.env.BASE ?? "http://localhost:3216";
const only = process.argv[2]?.split(",");

async function playSome(page) {
  await page.waitForSelector(".bp-slot:not(:disabled)", { timeout: 30000 });
  for (let n = 0; n < 7; n++) {
    const slots = await page.$$(".bp-slot:not(:disabled):not(.used)");
    let placed = false;
    for (const s of slots) {
      await s.click();
      for (const cell of [0, 8, 16, 24, 32, 40, 48, 56, 4, 20, 36]) {
        const before = await page.locator(".bp-cell.on").count();
        await page.locator(".bp-board .bp-cell").nth(cell).click({ force: true });
        if ((await page.locator(".bp-cell.on").count()) !== before) {
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) break;
  }
}
const shots = [
  { name: "lobby", route: "/lobby" },
  { name: "block-puzzle", route: "/design/play", wait: 6000, act: playSome },
  { name: "holdem", route: "/design/table", wait: 6000 },
  { name: "wallet", route: "/wallet" },
  { name: "backing", route: "/backing" },
  { name: "leaderboard", route: "/leaderboard", wait: 20000 },
  { name: "account", route: "/account/DA9KbPuRzY5ewEDEgDwqGJUrUstdQkgUwrFFCbDCP1bS" },
];
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
for (const s of shots) {
  if (only && !only.includes(s.name)) continue;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const route = s.route + (s.route.includes("?") ? "&" : "?") + "dev=demo";
  await page.goto(BASE + route, { waitUntil: "load", timeout: 240000 });
  await page.waitForTimeout(s.wait ?? 6000);
  for (const label of ["Got it"]) await page.getByRole("button", { name: label }).first().click({ timeout: 5000 }).catch(() => {});
  await page.addStyleTag({ content: "nextjs-portal, [data-nextjs-toast], #__next-build-watcher { display: none !important }" });
  if (s.act) await s.act(page).catch((e) => console.log("act failed", e.message.split("\n")[0]));
  await page.waitForTimeout(800);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ type: "png" });
  let q = 80;
  let buf;
  do {
    buf = await sharp(png).resize({ width: 1280 }).webp({ quality: q }).toBuffer();
    q -= 8;
  } while (buf.length > 190_000 && q > 30);
  await sharp(buf).toFile(`${OUT}/shot-${s.name}.webp`);
  console.log(s.name, Math.round(buf.length / 1024) + " KB");
  await ctx.close();
}
await browser.close();
