/**
 * Lobby screenshots for the redesign: signed out (?dev=out) and signed in (dev wallet with fixture data, ?dev=demo), four viewports.
 * Needs a dev server started with NEXT_PUBLIC_DEV_WALLET=1 and a playwright-core install:
 *
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3100 node scripts/screenshot-lobby.mjs [route] [tag]
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../docs/screens");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE ?? "http://localhost:3100";
const route = process.argv[2] ?? "/";
const tag = process.argv[3] ?? "lobby";
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;

const sizes = [
  [1920, 1200],
  [1440, 900],
  [1024, 768],
  [390, 844],
];
const modes = [
  ["signedout", "out"],
  ["signedin", "demo"],
];

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
for (const [w, h] of sizes) {
  for (const [name, slot] of modes) {
    const key = `${w}-${name}`;
    if (only && !only.includes(key) && !only.includes(String(w)) && !only.includes(name)) continue;
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${route}${route.includes("?") ? "&" : "?"}dev=${slot}`, { waitUntil: "load", timeout: 180000 });
    await page.waitForTimeout(name === "signedin" ? 4500 : 3000);
    await page.locator(".dots button").first().click().catch(() => undefined);
    await page.waitForTimeout(900);
    await page.evaluate(() => document.fonts.ready);
    const file = `${OUT}/redesign-${tag}-${w}-${name}.png`;
    await page.screenshot({ path: file, fullPage: false });
    console.log("wrote", file);
    await ctx.close();
  }
}
await browser.close();
