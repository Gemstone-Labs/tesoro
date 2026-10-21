/**
 * Plays Practice Hold'em at phone sizes and checks the table keeps one height through every moment of a hand:
 * dealing (no hand name yet), play (your hand name), showdown (both hand names, the result card, the Winner tag).
 * Also checks the pinned action bar keeps one height (turns, raise labels that wrap as the blinds climb), that
 * "Sending…" fits each button, and that there is no "Actions unlock on your turn" line. Exits 1 when a check fails.
 *
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3301 node scripts/holdem-phone-table-check.mjs
 *
 * Via pnpm (BASE defaults to http://localhost:3301; PW must point at a playwright-core install, it is not an app dependency):
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3311 pnpm --filter @tesoro/app check:holdem-phone-table
 *
 * Env: BASE, PW (default "playwright-core"), CHROME (browser executable), HANDS (showdowns or folds to watch per size, default 4).
 */
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const BASE = process.env.BASE ?? "http://localhost:3301";
const CHROME = process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome");
const HANDS = Number(process.env.HANDS ?? 4);
const SIZES = [
  { w: 412, h: 915 },
  { w: 360, h: 780 },
];

// Runs in the page: records every distinct table height with what was on the felt at that moment.
function watch() {
  const seen = new Map();
  const bars = new Map();
  let ends = 0;
  let inEnd = false;
  const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0);
  setInterval(() => {
    const felt = document.querySelector(".hdx-felt");
    if (!felt) return;
    const table = h(document.querySelector(".hdx-table"));
    const labels = [...felt.querySelectorAll(".hd-handlabel")].length;
    const win = felt.querySelector(".hdx-win");
    if (win && !inEnd) ends++;
    inEnd = !!win;
    if (!seen.has(table)) seen.set(table, `${labels} hand name(s), ${win ? `result "${win.textContent}"` : "pot"}`);
    const bar = document.querySelector(".hdx-actions:not(.raise-open)");
    const btns = [...document.querySelectorAll(".hdx-btn span")].map((s) => s.textContent).join(" | ");
    if (bar && !bars.has(h(bar))) bars.set(h(bar), btns);
  }, 50);
  window.__hd = () => ({ heights: Object.fromEntries(seen), bars: Object.fromEntries(bars), ends, ended: !!document.querySelector(".hdx-end") });
  // "Sending…" replaces the pressed button's label while a move is sent: it must fit every button on one line.
  window.__sendingFits = () =>
    [...document.querySelectorAll(".hdx-btn")].every((b) => {
      const s = b.querySelector("span");
      const was = s.textContent;
      b.classList.add("sending");
      s.textContent = "Sending…";
      const r = s.getBoundingClientRect();
      const one = r.height < parseFloat(getComputedStyle(s).lineHeight) * 1.5 && r.width <= b.clientWidth - 12;
      s.textContent = was;
      b.classList.remove("sending");
      return one;
    });
}

const failures = [];
const browser = await chromium.launch({ executablePath: CHROME });
try {
  for (const { w, h } of SIZES) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`${BASE}/play/practice?game=holdem`, { waitUntil: "networkidle" });
    await page.waitForSelector(".hdx-felt");
    await page.evaluate(watch);
    const deadline = Date.now() + 120_000;
    let state = await page.evaluate(() => window.__hd());
    while (state.ends < HANDS && !state.ended && Date.now() < deadline) {
      const btn = page.locator(".hdx-btn.primary:not([disabled])");
      if (await btn.count()) await btn.click().catch(() => {});
      await page.waitForTimeout(400);
      state = await page.evaluate(() => window.__hd());
    }
    const heights = Object.keys(state.heights);
    const bars = Object.keys(state.bars);
    const tag = `${w}x${h}`;
    console.log(`${tag}: ${state.ends} hand end(s), table heights ${JSON.stringify(state.heights)}, action bar heights ${JSON.stringify(state.bars)}`);
    if (state.ends === 0) failures.push(`${tag}: no hand finished, the check saw nothing`);
    if (heights.length !== 1) failures.push(`${tag}: table changed height (${heights.join(", ")} px)`);
    if (bars.length !== 1) failures.push(`${tag}: action bar changed height (${bars.join(", ")} px)`);
    if (!(await page.evaluate(() => window.__sendingFits()))) failures.push(`${tag}: "Sending…" does not fit a button on one line`);
    if (await page.getByText("Actions unlock on your turn").count()) failures.push(`${tag}: "Actions unlock on your turn" is back`);
    await page.close();
  }
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(`FAIL\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("OK: the Hold'em table and action bar keep one height on phones");
