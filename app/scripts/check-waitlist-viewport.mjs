/** Check the one-screen waitlist at desktop, portrait and landscape sizes, with all optional fields open.
 * BASE=http://localhost:3377 PW=/path/to/playwright-core/index.mjs OUT=/path/to/evidence node scripts/check-waitlist-viewport.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.PW ?? 'playwright-core');
const base = process.env.BASE ?? 'http://localhost:3377';
const out = resolve(process.env.OUT ?? '.tmp/waitlist-viewport');
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const results = [];
const failures = [];
try {
  for (const [width, height] of [[1440, 900], [1280, 720], [1920, 1080], [390, 844], [375, 667], [320, 568], [844, 390]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('.vw[data-motion]');
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: 'Pause motion' }).click();
    for (const state of ['default', 'studio', 'error-and-count', 'success']) {
      if (state === 'studio') {
        await page.getByRole('button', { name: 'I make games', exact: true }).click();
        await page.locator('#wl-studio').fill('Example studio');
      }
      if (state === 'error-and-count') await page.evaluate(() => {
        document.querySelector('#wl-error').textContent = "We couldn't save that just now. Try again in a moment.";
        const count = document.createElement('p');
        count.className = 'wl-count mono';
        count.textContent = '1,234 on the waitlist';
        document.querySelector('.wl-main').append(count);
      });
      if (state === 'success') {
        await page.locator('#wl-email').fill('viewport-check@example.com');
        await page.locator('input[name="company"]').evaluate((input) => { input.value = 'verification'; });
        await page.getByRole('button', { name: 'Join the waitlist' }).click();
        await page.waitForSelector('.wl-done-title');
      }
      await page.evaluate(() => scrollTo(0, 0));
      const check = await page.evaluate(() => {
        const errors = [];
        const root = document.documentElement;
        const titleSize = parseFloat(getComputedStyle(document.querySelector('.wl-h1')).fontSize);
        // Preserve the large headline while making the surrounding layout fit.
        const minTitleSize = innerWidth >= 1200 ? (innerWidth >= 1400 ? 80 : 70)
          : innerWidth <= 640 ? (innerHeight <= 600 ? 32 : innerHeight <= 740 ? 40 : 44) : 32;
        if (titleSize < minTitleSize) errors.push(`headline ${titleSize}px is smaller than ${minTitleSize}px`);
        if (root.scrollHeight > innerHeight + 1) errors.push(`page height ${root.scrollHeight} exceeds ${innerHeight}`);
        if (root.scrollWidth > innerWidth + 1) errors.push('page scrolls horizontally');
        const selectors = ['.vw-toggle', '.wl-logo', '.wl-kicker', '.wl-h1', '.wl-lede', '.wl-role-chip', '#wl-studio', '#wl-email', '.wl-join', '.wl-links a', '.wl-try a', '.wl-more a', '#wl-error', '.wl-count', '.wl-done-title', '.wl-done-note', '.wl-done-links a'];
        for (const selector of selectors) for (const el of document.querySelectorAll(selector)) {
          if (!el.getClientRects().length || !el.textContent?.trim() && !el.matches('input')) continue;
          const r = el.getBoundingClientRect();
          if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) errors.push(`${selector} outside viewport: ${JSON.stringify(r.toJSON())}`);
        }
        const main = document.querySelector('.wl-main').getBoundingClientRect();
        const header = document.querySelector('.wl-top').getBoundingClientRect();
        if (main.top < header.bottom + 3) errors.push('content overlaps header');
        const chips = document.querySelector('.wl-role-chips');
        if (chips && chips.scrollWidth > chips.clientWidth + 1) errors.push('role choices need horizontal scrolling');
        for (const el of document.querySelectorAll('.vw-toggle, .wl-role-chip, #wl-studio, #wl-email, .wl-join')) {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!hit || !(hit === el || el.contains(hit))) errors.push(`${el.id || el.className} is clipped or obscured`);
        }
        return { errors, titleSize, pageHeight: root.scrollHeight, viewportHeight: innerHeight, main: { top: main.top, bottom: main.bottom } };
      });
      results.push({ width, height, state, ...check });
      failures.push(...check.errors.map((error) => `${width}x${height} ${state}: ${error}`));
      if (state !== 'error-and-count') await page.screenshot({ path: `${out}/${width}x${height}-${state}.png` });
    }
    await context.close();
  }
  await writeFile(`${out}/viewport-checks.json`, JSON.stringify(results, null, 2));
  assert.deepEqual(failures, [], 'all content must fit, remain reachable, and require no scroll');
  console.log(`PASS: ${results.length} viewport/state combinations fit without scrolling or clipped controls. Evidence: ${out}`);
} finally { await browser.close(); }
