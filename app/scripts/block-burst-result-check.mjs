/** PW=/path/to/playwright-core BASE=http://localhost:3391 node scripts/block-burst-result-check.mjs */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const base = process.env.BASE ?? "http://localhost:3391";
const out = process.env.OUT ?? join(homedir(), ".cache/tesoro-tmp/block-burst-result");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome") });
try {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    const mobile = width < 640;
    const page = await browser.newPage({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
    await page.clock.install();
    await page.goto(`${base}/play/practice?game=block-puzzle&dev=demo`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.locator(".bp-board.live").waitFor({ timeout: 60000 });
    await page.locator(".fx-countdown").waitFor({ state: "hidden" });
    const score = page.locator(".bp-score-n");
    assert.ok(await score.isVisible(), "Live score must be visible during play");
    const piece = page.locator(".bp-slot:not(:disabled)").first();
    const expected = await piece.locator(".bp-cell").count();
    const activate = (locator) => mobile ? locator.tap() : locator.click();
    await activate(piece);
    await activate(page.locator(".bp-board button").first());
    await page.waitForFunction((n) => document.querySelector(".bp-score-n").textContent === String(n), expected);
    const before = await page.locator(".bp-board").boundingBox();
    // Advance the actual game clock to time-up without changing component state or the DOM.
    await page.clock.fastForward(91_000);
    const result = page.getByRole("dialog", { name: "Game over", exact: true });
    await result.waitFor();
    await page.waitForFunction((n) => document.querySelector(".bp-final").textContent === String(n), expected);
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.screenshot({ path: join(out, `result-${width}.png`) });
    assert.equal(await score.isVisible(), false, "Game over must hide the duplicate live score");
    assert.ok(await result.locator(".bp-final").isVisible(), "Result must retain the final score");
    const after = await page.locator(".bp-board").boundingBox();
    assert.deepEqual(after, before, "Ending the game must keep the board in place");
    await activate(result.getByRole("button", { name: "Play again", exact: true }));
    await page.locator(".bp-board.live").waitFor();
    assert.ok(await score.isVisible(), "Play again must restore the live score");
    assert.equal(await score.textContent(), "0", "Play again must reset the live score");
    console.log(`PASS ${width}x${height}: score visible in play, hidden at time-up, final score retained, stable board, restored on replay`);
    await page.close();
  }
} finally {
  await browser.close();
}
