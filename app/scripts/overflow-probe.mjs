/** Lists elements wider than the viewport: PW=... BASE=... node scripts/overflow-probe.mjs /wallet?dev=demo */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await page.goto(`${process.env.BASE ?? "http://localhost:3110"}${process.argv[2]}`, { waitUntil: "load", timeout: 180000 });
await page.waitForTimeout(4000);
const out = await page.evaluate(() =>
  [...document.querySelectorAll("body *")]
    .filter((e) => e.getBoundingClientRect().right > 391 && getComputedStyle(e).position !== "fixed")
    .slice(0, 12)
    .map((e) => `${e.tagName}.${e.className && e.className.baseVal === undefined ? e.className : ""} ${Math.round(e.getBoundingClientRect().right)}`),
);
console.log(out.join("\n"));
await browser.close();
