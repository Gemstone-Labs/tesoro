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
