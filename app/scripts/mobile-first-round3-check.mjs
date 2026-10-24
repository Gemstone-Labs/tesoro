/** Checks the founder's round-3 game fixes against an existing dev server. Starts no server or build.
 * PW=/path/to/playwright-core BASE=http://localhost:3391 OUT=/path/to/screenshots node scripts/mobile-first-round3-check.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const base = process.env.BASE ?? "http://localhost:3391";
const out = process.env.OUT ?? join(homedir(), ".cache/tesoro-tmp/mobile-first-round3/after");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"), headless: true });
let passed = 0;
let failed = 0;
const errors = [];
const snapshot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });
const full = (page) => page.evaluate(() => document.documentElement.classList.contains("game-full"));
async function fits(page) {
  const sizes = await page.locator(".fx-arena").evaluate((e) => ({ h: e.clientHeight, sh: e.scrollHeight, w: e.clientWidth, sw: e.scrollWidth }));
  assert(sizes.sh <= sizes.h + 1 && sizes.sw <= sizes.w + 1, `Arena overflows: ${JSON.stringify(sizes)}`);
  assert.equal(await page.locator(".fx-arena").evaluate((e) => { e.scrollTop = 100; return e.scrollTop; }), 0, "Arena scrolls");
  return sizes;
}
async function menu(page, name) {
  await page.getByRole("button", { name: "Game menu", exact: true }).click();
  const list = page.getByRole("menu");
  await list.waitFor();
  assert(await list.evaluate((e) => e.parentElement === document.body), "Menu must escape cut ancestors");
  const hit = await list.evaluate((e) => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.left + 30, r.bottom - 20)); });
  assert(hit, "Menu is clipped or behind another card");
  await snapshot(page, `${name}-menu`);
  await page.keyboard.press("Escape");
  assert(await full(page), "Closing the menu also exited the window cover");
  await list.waitFor({ state: "hidden" });
}
async function pausedState(page, game) {
  return page.evaluate((g) => {
    if (g === "block-puzzle") return { time: document.querySelector(".bpx-ring span")?.textContent, pieces: [...document.querySelectorAll(".bp-cell")].map((e) => e.className) };
    if (g === "trading-duel") return { time: document.querySelector(".tg-strip-clock")?.textContent, grid: [...document.querySelectorAll(".tg-box")].map((e) => e.className), scores: [...document.querySelectorAll(".tg-score")].map((e) => e.textContent) };
    return { time: [...document.querySelectorAll(".vg-ring-arc")].map((e) => e.getAttribute("stroke-dashoffset")), pieces: [...document.querySelectorAll(".vg-piece")].map((e) => `${e.getAttribute("style")}|${e.getAttribute("aria-label")}`) };
  }, game);
}
try {
  for (const phone of process.env.PHONE ? [process.env.PHONE === "true"] : [false, true]) {
    const size = phone ? "phone" : "desktop";
    for (const game of (process.env.GAMES ?? "block-puzzle,holdem,trading-duel,vanguard").split(",")) {
      const name = `${game}-${size}`;
      const page = await browser.newPage({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: phone, hasTouch: phone });
      try {
        await page.clock.install();
        await page.goto(`${base}/play/practice?game=${game}`, { waitUntil: "domcontentloaded" });
        await page.locator("html.game-full").waitFor();
        const board = page.locator(game === "block-puzzle" ? ".bp-board" : game === "holdem" ? ".hdx-felt" : game === "trading-duel" ? ".tg-stage" : ".vg-board");
        await board.waitFor({ timeout: 60000 });
        if (game !== "holdem") await page.waitForFunction(() => { const b = document.querySelector('button[aria-label="Pause"]'); return b && !b.disabled; }, undefined, { timeout: 20000 });
        else {
          await page.locator(".hdx-btn:not(:disabled)").first().waitFor();
          await page.waitForTimeout(1800);
        }
        await snapshot(page, name);
        await menu(page, name);
        const dimensions = await fits(page);
        if (game === "holdem") {
          assert.equal(await page.getByRole("button", { name: "Pause", exact: true }).count(), 0);
          assert.match(await page.locator(".hdx-level").innerText(), /Blinds/);
          await page.keyboard.press("f");
          assert.equal(await full(page), false);
          await page.keyboard.press("f");
          assert(await full(page));
          await page.waitForFunction(() => [...document.querySelectorAll(".hdx-btn")].some(b => !b.disabled));
          await page.keyboard.press("g");
          await page.waitForFunction(() => [...document.querySelectorAll(".hd-say")].some(e => /Fold/i.test(e.textContent)));
        } else {
          await page.getByRole("button", { name: "Pause", exact: true }).click();
          await page.getByRole("dialog", { name: "Paused", exact: true }).waitFor();
          await page.waitForTimeout(150);
          const before = await pausedState(page, game);
          await snapshot(page, `${name}-paused`);
          await page.waitForTimeout(1600);
          assert.deepEqual(await pausedState(page, game), before, "Clock, bot or board advanced while paused");
          await page.getByRole("dialog", { name: "Paused", exact: true }).getByRole("button", { name: "Resume", exact: true }).click();
          await page.getByRole("dialog", { name: "Paused", exact: true }).waitFor({ state: "hidden" });
          await page.waitForTimeout(1200);
          assert.notDeepEqual(await pausedState(page, game), before, "Practice did not continue after Resume");
          if (game === "vanguard") {
            for (let i = 0; i < 12 && await page.locator(".vg-end").count() === 0; i++) {
              await page.clock.fastForward(11000);
              await page.waitForTimeout(900);
            }
            await page.locator(".vg-end").waitFor();
            assert(await full(page), "Vanguard cover dropped at the result");
            assert.equal(await page.getByRole("link", { name: "Back to games", exact: true }).getAttribute("href"), "/play");
            await snapshot(page, `${name}-end`);
            await page.getByRole("button", { name: "Play again", exact: true }).click();
            assert(await full(page));
            await page.getByRole("button", { name: "Game menu", exact: true }).click();
            await page.getByRole("menuitem", { name: "Leave", exact: true }).click();
            await page.waitForURL(/\/play$/);
            await page.waitForFunction(() => !document.documentElement.classList.contains("game-full"));
          }
          if (game === "block-puzzle" || game === "trading-duel") {
            await page.clock.fastForward(game === "block-puzzle" ? 95000 : 160000);
            await page.getByRole("button", { name: "Play again", exact: true }).waitFor({ timeout: 10000 });
            assert(await full(page), "Cover dropped at the end");
            const back = page.getByRole("link", { name: "Back to games", exact: true });
            assert.equal(await back.getAttribute("href"), "/play");
            await snapshot(page, `${name}-end`);
            await page.getByRole("button", { name: "Play again", exact: true }).click();
            assert(await full(page), "Cover dropped on Play again");
            await page.getByRole("button", { name: "Game menu", exact: true }).click();
            await page.getByRole("menuitem", { name: "Leave", exact: true }).click();
            await page.waitForURL(/\/play$/);
            await page.waitForFunction(() => !document.documentElement.classList.contains("game-full"));
            assert.equal(await full(page), false, "Leave kept the window cover");
          }
        }
        console.log(`PASS ${name}: viewport ${JSON.stringify(dimensions)}, portal, controls${game === "holdem" ? ", F/G keys" : ", pause/resume"}`);
        passed++;
      } catch (e) {
        failed++;
        errors.push(`${name}: ${e.stack}`);
        console.error(`FAIL ${name}: ${e.message}`);
        await snapshot(page, `${name}-failure`).catch(() => {});
      } finally { await page.close(); }
    }
  }
} finally { await browser.close(); }
console.log(`${passed} passed; ${failed} failed`);
if (errors.length) { console.error(errors.join("\n\n")); process.exitCode = 1; }
