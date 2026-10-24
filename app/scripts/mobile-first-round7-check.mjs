import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright-core');
const base = process.env.BASE ?? 'http://localhost:3391';
const out = process.env.OUT ?? path.join(homedir(), '.cache/tesoro-tmp/mobile-first-round7/after');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? path.join(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'), headless: true });
const results = { vault: [], games: [], pageErrors: [], consoleWarnings: [] };
const sizes = [[390, 844], [360, 780], [412, 844], [1440, 900]];
try {
  for (const [width, height] of sizes) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 1024, hasTouch: width < 1024 });
    // Review the content after the existing first-visit tip has been dismissed.
    await context.addInitScript(() => localStorage.setItem('tesoro-guide-dismissed', JSON.stringify(['wallet-first'])));
    const page = await context.newPage();
    page.on('pageerror', (error) => results.pageErrors.push(error.message));
    page.on('console', (msg) => { if (['warning', 'error'].includes(msg.type())) results.consoleWarnings.push(msg.text()); });
    if (width === 390 || width === 1440) {
      await page.goto(`${base}/vault?dev=demo`, { waitUntil: 'domcontentloaded' });
      const card = page.locator('.wl-hero');
      await card.waitFor();
      await page.waitForFunction(() => document.querySelector('.wl-total-fig b')?.textContent !== '—');
      await page.waitForTimeout(1200);
      const toggle = page.getByRole('switch', { name: 'Pro view' }).first();
      const snapshots = [];
      for (const mode of ['simple', 'pro']) {
        const on = await toggle.getAttribute('aria-checked') === 'true';
        if (on !== (mode === 'pro')) await toggle.click();
        await page.waitForTimeout(300);
        await page.evaluate(() => window.scrollTo(0, 0));
        const state = await card.evaluate((el) => {
          const number = (text) => Number(text.replace(/[^0-9.]/g, ''));
          return {
            text: el.textContent,
            total: number(el.querySelector('.wl-total-fig b').textContent),
            rows: [...el.querySelectorAll('.wl-win')].map((row) => ({ label: row.getAttribute('aria-label'), amount: number(row.querySelector('.wl-win-fig b').textContent) })),
            buttons: [...el.querySelectorAll('.wl-win-action button')].map((button) => ({ label: button.textContent, disabled: button.disabled })),
          };
        });
        assert.deepEqual(state.rows.map((row) => row.label), ['Redeemable now', 'Pending']);
        assert.equal(state.total, state.rows.reduce((sum, row) => sum + row.amount, 0));
        assert.deepEqual(state.buttons.map((button) => button.label), ['Redeem', 'Instant Redeem']);
        await card.getByRole('button', { name: 'About Pending', exact: true }).click();
        const tip = page.getByRole('tooltip').filter({ hasText: 'Gemas from your deposits.' });
        await tip.waitFor({ state: 'visible' });
        assert.match(await tip.textContent(), /Gemas you won/);
        await card.getByRole('button', { name: 'About Pending', exact: true }).click();
        await page.mouse.move(0, 0);
        await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
        await page.screenshot({ path: path.join(out, `vault-${mode}-${width}x${height}.png`), animations: 'disabled' });
        snapshots.push(state);
        results.vault.push({ width, height, mode, ...state });
      }
      assert.deepEqual(snapshots[0], snapshots[1], 'Simple and Pro must show identical cards');
      const redeem = card.getByRole('button', { name: 'Redeem', exact: true });
      if (await redeem.isEnabled()) {
        await redeem.click();
        await page.getByRole('dialog').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
      }
      const instant = card.getByRole('button', { name: 'Instant Redeem', exact: true });
      if (await instant.isEnabled()) {
        await instant.click();
        await page.getByRole('dialog').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
      }
    }
    for (const game of ['vanguard', 'holdem', 'trading-duel', 'block-puzzle']) {
      const images = [];
      const onRequest = (req) => { if (req.resourceType() === 'image') images.push(decodeURIComponent(req.url())); };
      page.on('request', onRequest);
      await page.goto(`${base}/play/${game}?dev=demo`, { waitUntil: 'domcontentloaded' });
      await page.locator('.gp-hero-art').waitFor();
      await page.locator('.gpill:not(.skel)').waitFor();
      await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
      await page.waitForFunction(() => {
        const img = document.querySelector('.gp-hero-art');
        return img?.complete && img.naturalWidth > 0;
      });
      await page.waitForTimeout(300);
      const metrics = await page.evaluate(() => {
        const image = document.querySelector('.gp-hero-art');
        const frame = document.querySelector('.gp-art').getBoundingClientRect();
        const title = document.querySelector('.gp-art-title').getBoundingClientRect();
        const buttons = [...document.querySelectorAll('.gp-more .btn')].map((el) => {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return { text: el.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height, padding: parseFloat(style.paddingLeft), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
        });
        return { src: decodeURIComponent(image.currentSrc), artWidth: frame.width, artHeight: frame.height, titleBottom: title.bottom, frameBottom: frame.bottom, buttons, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(metrics.overflow, false, `${game} at ${width}: horizontal overflow`);
      assert.equal(metrics.buttons.length, 2);
      for (const btn of metrics.buttons) {
        assert.ok(btn.padding >= 16);
        assert.ok(btn.scrollWidth <= btn.clientWidth);
        assert.ok(btn.height >= 48);
      }
      if (width < 1024) {
        assert.match(metrics.src, /tile/);
        assert.ok(Math.abs(metrics.artWidth - metrics.artHeight) < 1, 'tile frame must be square');
        assert.ok(metrics.titleBottom <= metrics.frameBottom, 'title stays on art');
        assert.ok(metrics.buttons[1].y >= metrics.buttons[0].y + metrics.buttons[0].height, 'phone buttons stack');
        assert.ok(Math.abs(metrics.buttons[0].width - metrics.buttons[1].width) < 1);
      } else {
        assert.match(metrics.src, /hero/);
        assert.ok(Math.abs(metrics.buttons[0].y - metrics.buttons[1].y) < 1, 'desktop buttons pair');
      }
      // Isolate the actual header picture: Recent Matches legitimately loads its own wide banner art.
      const picture = await page.locator('.gp-art picture').evaluate((el) => el.outerHTML);
      const probe = await context.newPage();
      const pictureRequests = [];
      probe.on('request', (req) => { if (req.resourceType() === 'image') pictureRequests.push(decodeURIComponent(req.url())); });
      await probe.setContent(`<base href="${base}">${picture}`, { waitUntil: 'load' });
      assert.equal(pictureRequests.length, 1, 'header picture must download exactly one image');
      assert.match(pictureRequests[0], width < 1024 ? /tile/ : /hero/);
      await probe.close();
      await page.screenshot({ path: path.join(out, `${game}-${width}x${height}.png`), animations: 'disabled' });
      await page.locator('.gp-info:visible').click();
      await page.getByRole('dialog').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      results.games.push({ game, width, height, ...metrics, pictureRequests, imageRequests: images });
      page.off('request', onRequest);
    }
    await context.close();
  }
  assert.deepEqual(results.pageErrors, []);
  console.log(`PASS: ${results.vault.length} Vault modes, ${results.games.length} game/viewport cases; no page errors`);
} finally {
  await fs.writeFile(path.join(out, 'checks.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
