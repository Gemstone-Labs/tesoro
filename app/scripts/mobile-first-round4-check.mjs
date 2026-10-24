/** Round-4 checks against the existing dev server. Starts no server or build.
 * PW=/path/to/playwright-core BASE=http://localhost:3391 OUT=/path/to/after node scripts/mobile-first-round4-check.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const base = process.env.BASE ?? "http://localhost:3391";
const out = process.env.OUT ?? join(homedir(), ".cache/tesoro-tmp/mobile-first-round4/after");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"), headless: true });
const results = [];
const diagnostics = [];
const full = (page) => page.evaluate(() => document.documentElement.classList.contains("game-full"));
const snapshot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const labels = async (locator) => (await locator.locator("button, a").allTextContents()).map((s) => s.trim());
async function fits(page) {
  const sizes = await page.locator(".fx-arena").evaluate((e) => ({ h: e.clientHeight, sh: e.scrollHeight, w: e.clientWidth, sw: e.scrollWidth }));
  assert(sizes.sh <= sizes.h + 1 && sizes.sw <= sizes.w + 1, `Arena overflows: ${JSON.stringify(sizes)}`);
  assert.equal(await page.locator(".fx-arena").evaluate((e) => { e.scrollTop = 100; return e.scrollTop; }), 0, "Arena scrolls");
}
async function state(page, game) {
  return page.evaluate((g) => {
    if (g === "block-puzzle") return { time: document.querySelector(".bpx-ring span")?.textContent, pieces: [...document.querySelectorAll(".bp-cell")].map((e) => e.className) };
    if (g === "trading-duel") return { time: document.querySelector(".tg-strip-clock")?.textContent, picks: [...document.querySelectorAll(".tg-box")].map((e) => e.className), scores: [...document.querySelectorAll(".tg-score")].map((e) => e.textContent) };
    return { time: [...document.querySelectorAll(".vg-ring-arc")].map((e) => e.getAttribute("stroke-dashoffset")), pieces: [...document.querySelectorAll(".vg-piece")].map((e) => `${e.getAttribute("style")}|${e.getAttribute("aria-label")}`) };
  }, game);
}
async function controls(page, game, name) {
  await page.getByRole("button", { name: "Game menu", exact: true }).click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  const menuLabels = await labels(menu);
  assert(await menu.evaluate((e) => e.parentElement === document.body), "Menu is not portalled");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const paused = page.getByRole("dialog", { name: "Paused", exact: true });
  await paused.waitFor();
  await page.locator(".fx-countdown").waitFor({ state: "hidden" });
  assert.deepEqual(await labels(paused), ["Resume", ...menuLabels]);
  assert.equal(await paused.getByRole("menuitem").count(), 0);
  assert(await paused.locator("button, a").evaluateAll((actions) => actions.every((e) => {
    const r = e.getBoundingClientRect();
    return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })), "A pause action is clipped or covered");
  await snapshot(page, `${name}-paused`);
  const before = await state(page, game);
  await page.waitForTimeout(1400);
  assert.deepEqual(await state(page, game), before, "Practice advanced while paused");
  const sound = paused.getByRole("button", { name: /^Sound (on|off)$/ });
  const soundBefore = await sound.getAttribute("aria-pressed");
  await sound.click();
  assert.notEqual(await sound.getAttribute("aria-pressed"), soundBefore, "Sound did not toggle");
  await sound.click();
  if (game !== "block-puzzle") {
    const item = game === "trading-duel" ? "Key" : "Ranks and powers";
    await paused.getByRole("button", { name: item, exact: true }).click();
    const rules = page.getByRole("dialog", { name: item, exact: true });
    await rules.waitFor();
    await rules.getByRole("button", { name: game === "trading-duel" ? "Close" : "Close ranks and powers", exact: true }).click();
    assert(await paused.isVisible(), "Opening rules resumed Practice");
  }
  await paused.getByRole("button", { name: "Exit full screen", exact: true }).click();
  assert.equal(await full(page), false);
  await paused.getByRole("button", { name: "Full screen", exact: true }).click();
  assert(await full(page));
  await page.waitForTimeout(150);
  await fits(page);
  await paused.getByRole("button", { name: "Resume", exact: true }).click();
  await paused.waitFor({ state: "hidden" });
  await page.waitForTimeout(1400);
  assert.notDeepEqual(await state(page, game), before, "Practice did not resume");
  await page.getByRole("button", { name: "Game menu", exact: true }).click();
  assert.deepEqual(await labels(menu), menuLabels, "Actions or settings drifted from the menu");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await paused.getByRole("link", { name: "Leave", exact: true }).click();
  await page.waitForURL(/\/play$/);
  await page.waitForFunction(() => !document.documentElement.classList.contains("game-full"));
  assert.equal(await full(page), false, "Leave kept the window cover");
}
async function tradingLayout(page, phone) {
  const layout = await page.locator(".tg").evaluate((e) => {
    const rect = (selector) => e.querySelector(selector).getBoundingClientRect().toJSON();
    return { score: rect(".tg-scoreboard"), strip: rect(".tg-strip"), summary: rect(".tg-summary"), board: rect(".tg-stage"), bottom: document.querySelector(".fx-arena").getBoundingClientRect().bottom };
  });
  if (phone) assert(layout.strip.y >= layout.score.bottom, "Phone score and strip no longer stack");
  else {
    assert.equal(layout.score.y, layout.strip.y, "Desktop score and strip must share one row");
    assert(layout.strip.x >= layout.score.right, "Status is not on the right");
    assert(layout.summary.height <= 100, `Desktop card too tall: ${layout.summary.height}`);
    assert(layout.board.height >= 680, `Freed height did not reach the board: ${layout.board.height}`);
    assert(layout.board.bottom <= layout.bottom - 13, "Board extends past the cover");
  }
  return layout;
}
async function poolLayout(page, phone) {
  const layout = await page.getByRole("dialog", { name: "How the Pool works", exact: true }).evaluate((e) => {
    const r = e.getBoundingClientRect();
    const chart = e.querySelector(".lb-chart").getBoundingClientRect();
    const rules = e.querySelector(".lb-rules").getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(e.querySelector(".lb-chart h3"));
    return { width: r.width, x: r.x, right: r.right, sw: e.querySelector(".sheet-in").scrollWidth, cw: e.querySelector(".sheet-in").clientWidth, chartBottom: chart.bottom, rulesTop: rules.top, headingLines: range.getClientRects().length,
      columns: [...e.querySelectorAll(".lb-chart li")].map((col) => {
        const cr = col.getBoundingClientRect();
        return [...col.querySelectorAll("small, b, .lb-col-full, .lb-col-short")].filter((label) => getComputedStyle(label).display !== "none" && getComputedStyle(label).position !== "absolute").map((label) => {
          const lr = label.getBoundingClientRect();
          return { text: label.textContent, left: lr.left, right: lr.right, columnLeft: cr.left, columnRight: cr.right };
        });
      }) };
  });
  assert.equal(layout.width, phone ? 358 : 840, "Pool modal width is still constrained");
  assert(layout.x >= 16 && layout.right <= (phone ? 390 : 1440) - 16, "Modal overflows the viewport");
  assert(layout.sw <= layout.cw + 1, "Modal has horizontal overflow");
  assert.equal(layout.headingLines, 1, "Payout scale wraps");
  assert(layout.rulesTop >= layout.chartBottom, "Chart must sit above points");
  assert.equal(layout.columns.length, 10);
  for (const column of layout.columns) for (const label of column) assert(label.left >= label.columnLeft - 1 && label.right <= label.columnRight + 1, `Overlapping payout label: ${JSON.stringify(label)}`);
  return layout;
}
try {
  for (const phone of [false, true]) {
    const size = phone ? "phone" : "desktop";
    for (const game of ["trading-duel", "block-puzzle", "vanguard", "leaderboard"]) {
      const name = `${game}-${size}`;
      const page = await browser.newPage({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone });
      page.on("pageerror", (e) => diagnostics.push({ name, type: "pageerror", text: e.message }));
      page.on("console", (msg) => { if (msg.type() === "error") diagnostics.push({ name, type: "console", text: msg.text() }); });
      try {
        await page.goto(`${base}/${game === "leaderboard" ? "leaderboard?dev=demo" : `play/practice?game=${game}&dev=demo`}`, { waitUntil: "domcontentloaded" });
        let layout;
        if (game === "leaderboard") {
          await page.getByRole("button", { name: "How the Pool works", exact: true }).click({ timeout: 60000 });
          await page.waitForTimeout(400);
          layout = await poolLayout(page, phone);
          await snapshot(page, name);
        } else {
          await page.waitForFunction(() => { const b = document.querySelector('button[aria-label="Pause"]'); return b && !b.disabled; }, undefined, { timeout: 60000 });
          await fits(page);
          if (game === "trading-duel") {
            layout = await tradingLayout(page, phone);
            await snapshot(page, name);
          }
          await controls(page, game, name);
        }
        results.push({ name, pass: true, layout });
        console.log(`PASS ${name}`);
      } catch (e) {
        results.push({ name, pass: false, error: e.stack });
        console.error(`FAIL ${name}: ${e.message}`);
        await snapshot(page, `${name}-failure`).catch(() => {});
      } finally { await page.close(); }
    }
  }
} finally { await browser.close(); }
await writeFile(join(out, "checks.json"), JSON.stringify({ results, diagnostics }, null, 2) + "\n");
console.log(`${results.filter((r) => r.pass).length} passed; ${results.filter((r) => !r.pass).length} failed; ${diagnostics.filter((e) => e.type === "pageerror").length} page errors`);
if (results.some((r) => !r.pass)) process.exitCode = 1;
