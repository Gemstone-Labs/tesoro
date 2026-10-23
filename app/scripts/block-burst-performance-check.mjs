/** PW=/path/to/playwright-core node scripts/block-burst-performance-check.mjs
 * Real Chromium paints and touch input; only the game's clock is advanced.
 * Frame times are diagnostic, not a claim about physical phone performance.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright-core');
const out = process.env.OUT ?? join(homedir(), '.cache/tesoro-tmp/block-burst-performance');
const base = process.env.BASE ?? 'http://localhost:3391';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? join(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome') });
let page;
try {
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const realNow = performance.now.bind(performance);
    window.__advance = 0;
    performance.now = () => realNow() + window.__advance;
    window.__boardCommits = 0;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, renderers: new Map(),
      inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
      onCommitFiberUnmount: () => {},
      onCommitFiberRoot: (_id, root) => {
        function walk(fiber) {
          if (!fiber) return;
          if (fiber.type === 'div' && fiber.memoizedProps?.role === 'grid'
            && fiber.memoizedProps?.['aria-label'] === 'Block Burst board, 8 by 8'
            && fiber.memoizedProps !== fiber.alternate?.memoizedProps) window.__boardCommits++;
          walk(fiber.child);
          walk(fiber.sibling);
        }
        walk(root.current);
      },
    };
    window.__frames = [];
    let last = 0;
    const frame = time => {
      if (last) window.__frames.push(time - last);
      last = time;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.goto(`${base}/play/practice?game=block-puzzle&dev=demo`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.locator('.bp-board.live').waitFor();
  await page.locator('.fx-countdown').waitFor({ state: 'hidden' });
  await page.addStyleTag({ content: 'nextjs-portal { display:none !important; }' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('DOM.enable');
  const doc = await cdp.send('DOM.getDocument', { depth: 0 });
  const board = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.bp-board' });
  const { node } = await cdp.send('DOM.describeNode', { nodeId: board.nodeId });
  const results = [];
  const clock = () => page.locator('.bpx-ring span').innerText();
  const seconds = text => { const [minutes, remainder] = text.split(':').map(Number); return minutes * 60 + remainder; };
  async function advanceTo(seconds) {
    const [minutes, remainder] = (await clock()).split(':').map(Number);
    await page.evaluate(delta => { window.__advance += delta; }, (minutes * 60 + remainder - seconds) * 1000);
    await page.waitForTimeout(350);
  }
  async function sample(label) {
    await page.waitForTimeout(350);
    await page.evaluate(() => { window.__boardCommits = 0; window.__frames = []; });
    const events = [];
    const receive = ({ value }) => events.push(...value);
    cdp.on('Tracing.dataCollected', receive);
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink,cc', transferMode: 'ReportEvents' });
    await page.waitForTimeout(2200);
    const finished = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    await finished;
    cdp.off('Tracing.dataCollected', receive);
    const frames = await page.evaluate(() => window.__frames);
    const paints = events.filter(event => event.name === 'Paint' && event.ph === 'X');
    const metric = {
      label, low: await page.locator('.bp-board').evaluate(el => el.classList.contains('low')),
      boardCommits: await page.evaluate(() => window.__boardCommits),
      boardPaints: paints.filter(event => event.args?.data?.nodeId === node.backendNodeId).length,
      paints: paints.length, paintMs: paints.reduce((sum, event) => sum + (event.dur ?? 0) / 1000, 0),
      p95FrameMs: frames.sort((a, b) => a - b)[Math.floor(frames.length * .95)],
    };
    results.push(metric);
    console.log(JSON.stringify(metric));
    await writeFile(join(out, `${label}-trace.json`), JSON.stringify({ traceEvents: events }));
    await page.screenshot({ path: join(out, `${label}.png`) });
  }
  await sample('normal');
  await advanceTo(9);
  await sample('late');
  await writeFile(join(out, 'metrics.json'), JSON.stringify(results, null, 2));
  assert.ok(results[1].low, 'last-ten-seconds path active');
  assert.ok(results[1].boardPaints <= results[0].boardPaints + 5,
    `idle board repaint spike: ${results[0].boardPaints} normal vs ${results[1].boardPaints} final-seconds`);
  for (const result of results) {
    assert.ok(result.boardCommits > 0, 'render instrumentation observes the countdown');
    assert.ok(result.boardCommits <= 6, `${result.label}: countdown rerendered the board ${result.boardCommits} times in 2.2s`);
    assert.ok(result.paints <= 40, `${result.label}: timer caused ${result.paints} paints in 2.2s`);
  }

  // The display optimization must preserve pause, late input, and the exact expiry clock.
  await page.getByRole('button', { name: 'Pause', exact: true }).tap();
  const pausedClock = await clock();
  await page.evaluate(() => { window.__advance += 5000; });
  await page.waitForTimeout(250);
  assert.equal(await clock(), pausedClock, 'Practice does not consume paused time');
  await page.getByRole('dialog', { name: 'Paused' }).getByRole('button', { name: 'Resume', exact: true }).tap();
  await page.waitForTimeout(150);
  const resumedSeconds = seconds(await clock());
  assert.ok(resumedSeconds <= seconds(pausedClock) && resumedSeconds >= seconds(pausedClock) - 1, 'Practice resumes without consuming the five-second pause');
  const tray = await page.locator('.bp-slot').first().boundingBox();
  const bounds = await page.locator('.bp-board').boundingBox();
  const touch = (type, point) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] });
  await touch('touchStart', { x: tray.x + tray.width / 2, y: tray.y + tray.height / 2 });
  await touch('touchMove', { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 + 64 });
  await page.locator('.bp-board .pv').first().waitFor();
  const preview = await page.locator('.bp-board button').evaluateAll(cells => cells.flatMap((cell, i) => cell.classList.contains('pv') ? [i] : []));
  await touch('touchEnd');
  await page.locator('.bp-board .on').first().waitFor();
  const placed = await page.locator('.bp-board button').evaluateAll(cells => cells.flatMap((cell, i) => cell.classList.contains('on') ? [i] : []));
  assert.deepEqual(placed, preview, 'late touch placement matches preview');
  const warningIsPulsing = await page.locator('.bp-board-space').evaluate(el => el.getAnimations({ subtree: true }).some(animation => animation.animationName === 'bp-warning'));
  assert.ok(warningIsPulsing, 'last-seconds warning remains animated');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const warningAnimations = await page.locator('.bp-board-space').evaluate(el => el.getAnimations({ subtree: true }).filter(animation => animation.animationName === 'bp-warning').length);
  assert.equal(warningAnimations, 0, 'reduced motion disables warning pulse');
  await advanceTo(1);
  await page.getByRole('dialog', { name: 'Game over' }).waitFor({ timeout: 2000 });
  assert.equal(await clock(), '00:00');
  assert.equal(await page.locator('.bp-board.low').count(), 0, 'warning ends with the game');
  assert.deepEqual(errors, [], 'no runtime errors');
  console.log('PASS: rendering budgets, late touch placement, pause/resume, reduced motion, timer expiry');
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(out, 'failure.png') });
    await writeFile(join(out, 'failure.txt'), await page.locator('body').innerText());
  }
  throw error;
} finally {
  await browser.close();
}
