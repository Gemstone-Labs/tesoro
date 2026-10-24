import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const base = process.env.BASE ?? "http://localhost:3391";
const out = process.env.OUT ?? join(homedir(), ".cache/tesoro-tmp/mobile-first-round8/after");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
  args: ["--no-sandbox"],
});
let release;
const gate = new Promise((resolve) => { release = resolve; });
try {
  // Live reads deliberately bypass the synchronous demo fixture, so the actual request can be held.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  let held = 0;
  await page.route("**/api/chain/accounts?*", async (route) => {
    held++;
    await gate;
    await route.continue();
  });
  await page.goto(`${base}/play`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  const strip = page.locator('.live-wins[aria-busy="true"]');
  await strip.waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll(".game-tile img").length === 4);
  await page.waitForTimeout(1500);
  assert.ok(held > 0, "actual chain list request must be intercepted");
  const before = await strip.boundingBox();
  assert.equal(before.height, 46);
  assert.equal(await strip.locator(".lw-placeholder").count(), 3);
  assert.equal(await strip.locator(".lw-placeholder").first().evaluate((el) => getComputedStyle(el, "::before").animationName), "skel");
  const gridBefore = await page.locator(".game-tile").first().boundingBox();
  await page.screenshot({ path: join(out, "play-loading-390.png"), animations: "allow" });
  release();
  await strip.waitFor({ state: "hidden", timeout: 90000 });
  const loaded = page.locator(".live-wins");
  const after = await loaded.count() ? await loaded.boundingBox() : null;
  const gridAfter = await page.locator(".game-tile").first().boundingBox();
  if (after) {
    assert.equal(after.height, before.height, "loaded strip must reserve the same height");
    assert.equal(gridAfter.y, gridBefore.y, "wins loading must not move the grid");
    assert.ok(await loaded.locator("a").count() > 0, "loaded winners must link to Matches");
  }
  await page.screenshot({ path: join(out, "play-live-loaded-390.png") });
  const result = { heldRequests: held, before, after, gridBefore, gridAfter, loadedWins: await loaded.locator(".lw-track > li:not([aria-hidden])").count() };
  await writeFile(join(out, "live-wins-results.json"), JSON.stringify(result, null, 2));
  console.log(`PASS: loading strip 46px, ${held} held requests; ${result.loadedWins} loaded wins${after ? "; strip height and grid position unchanged" : "; empty/unavailable strip hidden"}`);
} finally {
  release();
  await browser.close();
}
