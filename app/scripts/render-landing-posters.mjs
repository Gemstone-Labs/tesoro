/**
 * Renders the landing page's 3D scenes at rest on transparency, so the swap from poster to live canvas is invisible:
 * public/art/landing/{gem-poster,chains-wide,chains-tall}.{avif,webp}. Needs a dev server and playwright-core:
 *
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3131 node scripts/render-landing-posters.mjs
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/art/landing");
const BASE = process.env.BASE ?? "http://localhost:3131";
const SCENES = [
  { scene: "gem", file: "gem-poster", size: [960, 1200] },
  { scene: "chains-wide", file: "chains-wide", size: [1920, 800] },
  { scene: "chains-tall", file: "chains-tall", size: [900, 1154] },
];

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
for (const { scene, file, size } of SCENES) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/welcome/poster?scene=${scene}`, { waitUntil: "networkidle" });
  await page.waitForSelector('#poster[data-ready="true"]', { timeout: 90000 });
  await page.waitForTimeout(800);
  const dataUrl = await page.evaluate(() => document.querySelector("#poster canvas").toDataURL("image/png"));
  const png = Buffer.from(dataUrl.split(",")[1], "base64");
  await sharp(png).webp({ quality: 88, alphaQuality: 95 }).toFile(resolve(OUT, `${file}.webp`));
  await sharp(png).avif({ quality: 64, effort: 6 }).toFile(resolve(OUT, `${file}.avif`));
  await sharp(png).toFile(resolve(OUT, `../../../docs/screens/landing-poster-${scene}.png`));
  await page.close();
  console.log(file);
}
await browser.close();
