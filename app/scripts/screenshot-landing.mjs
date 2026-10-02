/**
 * Landing page screenshots into docs/screens/landing-<theme>-<width>.png: the full page at 1920 and 390,
 * dark and light, with reduced motion (every section in its final state), plus viewport frames of the
 * hero and the pinned Gemas section with motion on.
 *
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3131 node scripts/screenshot-landing.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
const BASE = process.env.BASE ?? "http://localhost:3131";
mkdirSync(OUT, { recursive: true });

const SIZES = [
  [1920, 1080],
  [390, 844],
];

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
for (const theme of ["dark", "light"]) {
  for (const [width, height] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
    await ctx.addInitScript((t) => localStorage.setItem("tesoro-landing-theme", t), theme);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      for (const img of document.querySelectorAll("img")) img.loading = "eager";
      await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r)))));
    });
    // Stitched from viewport frames: a native full-page capture resizes the viewport and stretches svh sections.
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    const tiles = [];
    for (let y = 0; y < total; y += height) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(250);
      const top = await page.evaluate(() => scrollY);
      tiles.push({ input: await page.screenshot(), top, left: 0 });
      await page.evaluate(() => document.querySelector(".lp-nav")?.style.setProperty("visibility", "hidden"));
    }
    await sharp({ create: { width, height: total, channels: 3, background: "#000" } })
      .composite(tiles)
      .png()
      .toFile(resolve(OUT, `landing-${theme}-${width}.png`));
    console.log(`landing-${theme}-${width}.png`);
    await ctx.close();
  }
}

// Motion on: the first frame of the hero and the three Gemas beats, desktop dark.
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => localStorage.setItem("tesoro-landing-theme", "dark"));
const page = await ctx.newPage();
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(2200);
await page.screenshot({ path: resolve(OUT, "landing-motion-hero-1920.png"), timeout: 180000 });
const top = await page.evaluate(() => document.querySelector("#gemas").getBoundingClientRect().top + scrollY);
for (const beat of [0, 1, 2]) {
  await page.evaluate((y) => window.scrollTo(0, y), top + beat * 1080 * 0.68 + 40);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: resolve(OUT, `landing-motion-gemas-${beat + 1}-1920.png`), timeout: 180000 });
}
console.log("motion frames");
await browser.close();
