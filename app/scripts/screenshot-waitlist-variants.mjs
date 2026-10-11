// Screenshots of the waitlist's divider variants (?d=a..f) at 1440x900 and 390x844, and a labelled 3x2 contact sheet:
// docs/screens/waitlist-var-{a..f}-{1440,390}.png and waitlist-variants.png.
//   BASE=http://localhost:3217 PW=<path to playwright-core> node scripts/screenshot-waitlist-variants.mjs
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PW ?? "playwright-core");
const BASE = process.env.BASE ?? "http://localhost:3217";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
mkdirSync(OUT, { recursive: true });
const KEYS = (process.env.ONLY ?? "a,b,c,d,e,f").split(",");
const browser = await chromium.launch();
const errors = [];
for (const [suffix, width, height] of [["1440", 1440, 900], ["1280", 1280, 720], ["390", 390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${suffix}: ${e.message}`));
  for (const k of KEYS) {
    await page.goto(`${BASE}/?d=${k}`, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(k === "f" ? 4000 : 2200);
    const m = await page.evaluate(() => ({ h: document.documentElement.scrollWidth - document.documentElement.clientWidth, form: Math.round(document.querySelector(".wl-form")?.getBoundingClientRect().bottom ?? 0), paths: document.querySelectorAll(".dv path").length }));
    if (suffix !== "1280") await page.screenshot({ path: `${OUT}/waitlist-var-${k}-${suffix}.png` });
    console.log(k, suffix, "hscroll", m.h, "form bottom", m.form, "/", height, "paths", m.paths);
  }
  await ctx.close();
}
await browser.close();

const W = 720;
const H = 450;
const tiles = await Promise.all(
  KEYS.map(async (k, i) => ({
    input: await sharp(`${OUT}/waitlist-var-${k}-1440.png`)
      .resize(W, H)
      .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}"><rect x="14" y="14" width="40" height="40" fill="#090d0f" stroke="#eaefec" stroke-opacity=".5"/><text x="34" y="43" font-size="26" font-weight="800" font-family="sans-serif" fill="#eaefec" text-anchor="middle">${k.toUpperCase()}</text></svg>`) }])
      .png()
      .toBuffer(),
    left: (i % 3) * W,
    top: Math.floor(i / 3) * H,
  })),
);
await sharp({ create: { width: W * 3, height: H * 2, channels: 3, background: "#090d0f" } }).composite(tiles).png().toFile(`${OUT}/waitlist-variants.png`);
console.log(errors.length ? `ERRORS\n${errors.join("\n")}` : "no page errors");
