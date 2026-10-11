// Screenshots of the waitlist left-half prototypes (?v=A..E&proto=1) to docs/screens/waitlist-left-*.png and a contact sheet.
// BASE=http://localhost:3217 PW=<path to playwright-core> node scripts/screenshot-waitlist-left.mjs
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pw = await import(process.env.PW ?? "playwright-core");
const chromium = pw.chromium ?? pw.default.chromium;
const BASE = process.env.BASE ?? "http://localhost:3217";
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const errors = [];
const sizes = [["1440", 1440, 900], ["1280", 1280, 720], ["390", 390, 844]];
for (const v of ["A", "B", "C", "D", "E"]) {
  for (const [name, width, height] of sizes) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${v}${name}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${v}${name}: ${m.text()}`));
    await page.goto(`${BASE}/?v=${v}&proto=1`, { waitUntil: "networkidle", timeout: 120000 });
    if (v === "D") await page.mouse.move(width * 0.2, height * 0.3);
    if (v === "D" && name === "1440") await page.mouse.move(280, 240, { steps: 8 });
    await page.waitForTimeout(v === "C" ? 6000 : v === "E" ? 5200 : 4500);
    const m = await page.evaluate(() => ({
      h: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      form: Math.round(document.querySelector(".wl-form")?.getBoundingClientRect().bottom ?? -1),
      vh: innerHeight,
    }));
    console.log(v, name, "hscroll", m.h, "form bottom", m.form, "of", m.vh);
    if (name !== "1280") await page.screenshot({ path: `${OUT}/waitlist-left-${v.toLowerCase()}-${name}.png` });
    if (v === "B" && name === "1440") {
      await page.fill("#wl-email", "shot@example.com");
      await page.evaluate(() => (document.querySelector("input[name=company]").value = "x"));
      await page.click("button[type=submit]");
      await page.waitForSelector(".wl-done-title");
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}/waitlist-left-b-joined-1440.png` });
    }
    if (v === "D" && name === "1440") {
      await page.focus("#wl-email").catch(() => {});
      await page.waitForTimeout(1800);
      await page.screenshot({ path: `${OUT}/waitlist-left-d-focus-1440.png` });
    }
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? `ERRORS\n${errors.join("\n")}` : "no page errors");
