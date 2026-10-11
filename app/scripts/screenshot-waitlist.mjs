// Screenshots of the waitlist (/) and the landing (/welcome) to docs/screens/waitlist-*.png.
// Needs a server: BASE=http://localhost:3217 PW=<path to playwright-core> node scripts/screenshot-waitlist.mjs
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PW ?? "playwright-core");
const BASE = process.env.BASE ?? "http://localhost:3217";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const errors = [];
const shots = [
  ["1440", 1440, 900, "dark", "no-preference", "/"],
  ["1440-light", 1440, 900, "light", "no-preference", "/"],
  ["1280", 1280, 720, "dark", "no-preference", "/"],
  ["1280-light", 1280, 720, "light", "no-preference", "/"],
  ["390", 390, 844, "dark", "no-preference", "/"],
  ["390-light", 390, 844, "light", "no-preference", "/"],
  ["1440-reduced", 1440, 900, "dark", "reduce", "/"],
  ["welcome-1440", 1440, 900, "dark", "no-preference", "/welcome"],
];
for (const [name, width, height, scheme, motion, path] of shots) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: motion });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(2500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const form = await page.evaluate(() => {
    const r = document.querySelector(".wl-form")?.getBoundingClientRect();
    return r ? { bottom: Math.round(r.bottom), vh: innerHeight } : null;
  });
  const tiles = await page.evaluate(() => {
    const vs = [...document.querySelectorAll(".vw video")].filter((v) => v.offsetParent);
    const inView = vs.filter((v) => {
      const r = v.getBoundingClientRect();
      return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
    });
    return { rendered: vs.length, inView: inView.length, playing: vs.filter((v) => !v.paused).length };
  });
  await page.screenshot({ path: `${OUT}/waitlist-${name}.png` });
  console.log(name, "hscroll", overflow, "form", JSON.stringify(form), "tiles", JSON.stringify(tiles));
  await ctx.close();
}
// The wall must cover every column top to bottom at every moment of the loop: pause the drift at 0, 25, 50 and 75% and
// check that every visible column is flush with the tilted box's top and bottom and that its track (shifted by the drift)
// spans it, and that the box itself covers the wall region (an empty strip at the top or bottom would fail one of these).
for (const [name, width, height] of [["1440", 1440, 900], ["1280", 1280, 720], ["390", 390, 844]]) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 120000 });
  for (const [label, frac] of [["t0", 0], ["t25", 0.25], ["t50", 0.5], ["t75", 0.75]]) {
    await page.evaluate((f) => {
      for (const a of document.getAnimations()) {
        if (!a.effect?.target?.classList?.contains("vw-track")) continue;
        a.pause();
        a.effect.updateTiming({ delay: 0 });
        a.currentTime = f * a.effect.getComputedTiming().duration;
      }
    }, frac);
    await page.waitForTimeout(400);
    const bare = await page.evaluate(({ w, h }) => {
      const tall = w <= 640;
      const lineX = (y) => (0.28 + (y / h) * 0.44) * w;
      const lineY = (x) => (0.48 - (x / w) * 0.08) * h;
      let bare = 0;
      let sampled = 0;
      for (const y of [3, 14, 26, 38, h - 38, h - 26, h - 14, h - 3]) {
        for (let x = 4; x < w; x += 12) {
          // Only where the wall is meant to show: past the divider's reach.
          if (tall ? y > lineY(x) - 190 : x < lineX(y) + (w < 1000 ? 140 : 300)) continue;
          sampled++;
          if (!document.elementsFromPoint(x, y).some((e) => e.classList.contains("vw-tilt"))) bare++;
        }
      }
      const tilt = document.querySelector(".vw-tilt");
      for (const col of document.querySelectorAll(".vw-col")) {
        if (!col.offsetParent) continue;
        const track = col.firstElementChild;
        const ty = new DOMMatrix(getComputedStyle(track).transform).m42;
        const flush = col.offsetTop === 0 && col.offsetHeight === tilt.offsetHeight;
        const spans = ty <= 0.5 && track.offsetHeight + ty >= col.offsetHeight - 0.5;
        if (!flush || !spans) bare++;
        sampled++;
      }
      return { bare, sampled };
    }, { w: width, h: height });
    console.log("wall", name, label, "uncovered", bare.bare, "of", bare.sampled, "checks");
    if (name === "1440") await page.screenshot({ path: `${OUT}/waitlist-wall-${label}-1440.png` });
  }
  await ctx.close();
}

// A 2x crop of the divider's front.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/waitlist-zoom.png`, clip: { x: 560, y: 250, width: 400, height: 300 } });
  await ctx.close();
}

// The success state, through the honeypot (it answers success without storing anything).
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 120000 });
  await page.fill("#wl-email", "screenshot@example.com");
  await page.evaluate(() => (document.querySelector("input[name=company]").value = "x"));
  await page.click("button[type=submit]");
  await page.waitForSelector(".wl-done-title");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/waitlist-success.png` });
  await ctx.close();
}
await browser.close();
console.log(errors.length ? `ERRORS\n${errors.join("\n")}` : "no page errors");
