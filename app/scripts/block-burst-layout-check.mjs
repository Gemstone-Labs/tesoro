/** Run against the phone preview: PW=/path/to/playwright-core node scripts/block-burst-layout-check.mjs */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const base = process.env.BASE ?? "http://localhost:3391";
const out = process.env.OUT ?? join(homedir(), ".cache/tesoro-tmp/block-burst-layout");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome") });
const results = [];
try {
  for (const [width, height] of [[390, 844], [412, 824], [320, 568], [639, 900], [640, 900], [1440, 900]]) {
    const mobile = width < 640;
    const page = await browser.newPage({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
    await page.goto(`${base}/play/practice?game=block-puzzle&dev=demo`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.locator(".bp-board.live").waitFor({ timeout: 60000 });
    await page.locator(".fx-countdown").waitFor({ state: "hidden" });
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    const layout = await page.evaluate(() => {
      const rect = (selector) => {
        const { x, y, width, height, bottom } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height, bottom };
      };
      const arena = document.querySelector(".fx-arena");
      return { score: rect(".bpx-score"), bar: rect(".bpx-bar"), timer: rect(".bpx-ring"), board: rect(".bp-board"), run: rect(".bpx-run"), arena: { height: arena.clientHeight, scrollHeight: arena.scrollHeight, width: arena.clientWidth, scrollWidth: arena.scrollWidth } };
    });
    results.push({ width, height, ...layout });
    await page.screenshot({ path: join(out, `block-burst-${width}x${height}.png`) });
    await writeFile(join(out, "measurements.json"), JSON.stringify(results, null, 2));
    assert.ok(layout.arena.scrollHeight <= layout.arena.height + 1, `${width}: game must fit vertically`);
    assert.ok(layout.arena.scrollWidth <= layout.arena.width + 1, `${width}: game must fit horizontally`);
    if (mobile) {
      assert.ok(layout.score.y >= layout.bar.bottom, `${width}: score must be outside and below the toolbar`);
      assert.ok(layout.score.bottom < layout.board.y, `${width}: score must sit above the board`);
      assert.ok(Math.abs(layout.score.x + layout.score.width / 2 - (layout.board.x + layout.board.width / 2)) < 1, `${width}: score must be centered over the board`);
      assert.ok(layout.timer.x < layout.bar.x + layout.bar.width / 3, `${width}: timer must be on the left`);
    } else {
      assert.ok(layout.score.y >= layout.bar.y && layout.score.bottom <= layout.bar.bottom, `${width}: desktop score must remain in the toolbar`);
      assert.ok(Math.abs(layout.timer.x + layout.timer.width / 2 - (layout.bar.x + layout.bar.width / 2)) < 1, `${width}: desktop timer must remain centered`);
    }
    // Exercise the relocated score and board with real inputs, rather than layout alone.
    const activate = (locator) => mobile ? locator.tap() : locator.click();
    const piece = page.locator(".bp-slot:not(:disabled)").first();
    await activate(piece);
    await activate(page.locator(".bp-board button").first());
    await page.waitForFunction(() => Number(document.querySelector(".bp-score-n").textContent) > 0);
    if (width === 390) {
      const start = await page.locator(".bp-slot:not(:disabled)").first().boundingBox();
      const target = await page.locator(".bp-board button").last().boundingBox();
      const score = Number(await page.locator(".bp-score-n").textContent());
      const cdp = await page.context().newCDPSession(page);
      const from = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
      const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 + 64 };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
      for (let n = 1; n <= 8; n++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * n / 8, y: from.y + (to.y - from.y) * n / 8 }] });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction((before) => Number(document.querySelector(".bp-score-n").textContent) > before, score);
      await cdp.detach();
      await page.screenshot({ path: join(out, "block-burst-390-played.png") });
    }
    await activate(page.getByRole("button", { name: "Pause", exact: true }));
    await page.getByRole("dialog", { name: "Paused", exact: true }).waitFor();
    await activate(page.getByRole("dialog", { name: "Paused", exact: true }).getByRole("button", { name: "Resume", exact: true }));
    await page.getByRole("dialog", { name: "Paused", exact: true }).waitFor({ state: "hidden" });
    console.log(`PASS ${width}x${height}: layout, placement, score, pause/resume`);
    await page.close();
  }
} finally {
  await browser.close();
}
