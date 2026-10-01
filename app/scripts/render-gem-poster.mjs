/**
 * Renders the landing gem's poster from our own scene at its rest pose, so the swap from poster to the
 * live canvas is invisible: public/art/landing/gem-poster.{avif,webp} (1200×1200, transparent).
 *
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3131 node scripts/render-gem-poster.mjs
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/art/landing");
const BASE = process.env.BASE ?? "http://localhost:3131";

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 }, deviceScaleFactor: 1 });
await page.goto(`${BASE}/welcome/gem-poster`, { waitUntil: "networkidle" });
await page.waitForSelector('#gem-poster[data-ready="true"]', { timeout: 60000 });
await page.waitForTimeout(800);
const dataUrl = await page.evaluate(() => document.querySelector("#gem-poster canvas").toDataURL("image/png"));
const png = Buffer.from(dataUrl.split(",")[1], "base64");
await browser.close();

await sharp(png).webp({ quality: 88, alphaQuality: 95 }).toFile(resolve(OUT, "gem-poster.webp"));
await sharp(png).avif({ quality: 64, effort: 6 }).toFile(resolve(OUT, "gem-poster.avif"));
await sharp(png).toFile(resolve(OUT, "../../../docs/screens/landing-gem-poster.png"));
console.log("gem-poster.{webp,avif}");
