/** Verify hydration and responsive tiles through the actual phone preview origins.
 * PW=/path/to/playwright-core/index.mjs node scripts/check-waitlist-phone.mjs
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PW ?? 'playwright-core');
const origins = process.env.BASE ? [process.env.BASE] : ['http://omarchy.tailde1773.ts.net:3377', 'http://100.91.135.33:3377'];
const out = process.env.OUT ?? '.tmp/waitlist-phone';
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const base of origins) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('.vw[data-motion="running"]');
    await page.waitForFunction(() => Math.abs(document.querySelector('.vw-tile').getBoundingClientRect().width - 120) < 0.01);
    await page.getByRole('button', { name: 'I make games', exact: true }).click();
    await page.locator('#wl-studio').fill('Phone preview check');
    await page.getByRole('button', { name: 'Pause motion' }).click();
    await page.waitForSelector('.vw[data-motion="paused"]');
    for (const width of [320, 390, 412]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForFunction((expected) => document.querySelector('.vw').getBoundingClientRect().width === expected, width);
      // ResizeObserver replaces grid nodes; measure the current node inside the page, not a detached handle.
      await page.waitForFunction(() => Math.abs(document.querySelector('.vw-tile').getBoundingClientRect().width - 120) < 0.01);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${out}/${new URL(base).hostname}.png` });
    assert.deepEqual(errors, []);
    console.log(`PASS ${base}: hydrated; 120px tiles at 320/390/412px; role picker and pause work.`);
    await context.close();
  }
} finally { await browser.close(); }
