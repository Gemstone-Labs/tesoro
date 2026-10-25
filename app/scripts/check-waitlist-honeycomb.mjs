/**
 * Against a running Next app: BASE=http://localhost:3377 PW=/path/to/playwright-core/index.mjs
 * OUT=/path/to/evidence node scripts/check-waitlist-honeycomb.mjs
 * Exercises real playback, exclusive smooth highlights, constant diagonal drift and its wrap, responsive form layout,
 * pause/resume, reduced motion, Save-Data, and the honeypot success path (no waitlist entry is stored).
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const { chromium } = await import(process.env.PW ?? "playwright-core");
const base = process.env.BASE ?? "http://localhost:3377";
const out = resolve(process.env.OUT ?? ".tmp/waitlist-honeycomb");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const errors = [];

async function snapshot(page) {
  return page.evaluate(() => {
    const active = [...document.querySelectorAll('.vw-tile[data-highlighted="true"]')];
    const videos = [...document.querySelectorAll(".vw video")];
    const track = document.querySelector(".vw-track");
    const form = document.querySelector(".wl-form");
    const rect = form?.getBoundingClientRect();
    const content = document.querySelector(".wl-main").getBoundingClientRect();
    return {
      highlighted: active.length,
      id: active[0]?.dataset.tile,
      activeTime: active[0]?.querySelector("video").currentTime,
      activeX: active[0]?.getBoundingClientRect().left,
      activeY: active[0]?.getBoundingClientRect().top,
      fadeTime: active[0]?.querySelector('.vw-face').getAnimations()[0]?.currentTime,
      activePlaying: active[0] ? !active[0].querySelector("video").paused : false,
      playing: videos.filter((v) => !v.paused).length,
      x: new DOMMatrix(getComputedStyle(track).transform).m41,
      y: new DOMMatrix(getComputedStyle(track).transform).m42,
      opacity: active[0] ? Number(getComputedStyle(active[0].querySelector('.vw-face')).opacity) : null,
      motion: document.querySelector(".vw").dataset.motion,
      overflow: document.documentElement.scrollWidth > innerWidth,
      form: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null,
      content: { left: content.left, top: content.top },
      brokenMedia: videos.filter((v) => v.error).map((v) => v.dataset.clip),
      visibleClips: [...new Set(videos.filter((v) => {
        const r = v.getBoundingClientRect();
        return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
      }).map((v) => Number(v.dataset.clip)))],
    };
  });
}

try {
  for (const [width, height] of [[1440, 900], [390, 844], [320, 740], [1280, 720]]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector('.vw[data-motion="running"]', { timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.vw-tile[data-highlighted="true"] video')?.currentTime > 0);
    await page.evaluate(() => document.fonts.ready);
    const player = page.getByRole('button', { name: 'I play games', exact: true });
    const staker = page.getByRole('button', { name: 'I stake crypto', exact: true });
    const studio = page.getByRole('button', { name: 'I make games', exact: true });
    assert.equal(await page.locator('input[name="role"]').inputValue(), '', `${width}: roles start optional and empty`);
    await player.click();
    await staker.click();
    assert.equal(await player.getAttribute('aria-pressed'), 'true');
    assert.equal(await staker.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('input[name="role"]').inputValue(), 'player,staker', `${width}: multiple roles retained`);
    await studio.click();
    await page.locator('#wl-studio').fill('Browser test studio');
    const formData = await page.locator('.wl-form').evaluate((form) => {
      const data = new FormData(form);
      return { role: data.get('role'), studio: data.get('studio'), studioRequired: form.querySelector('#wl-studio').required };
    });
    assert.deepEqual(formData, { role: 'player,staker,studio', studio: 'Browser test studio', studioRequired: false });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: role row stays within page`);
    await page.screenshot({ path: `${out}/roles-${width}.png`, fullPage: true });
    await studio.click();
    assert.equal(await page.locator('#wl-studio').count(), 0, `${width}: studio field disappears when deselected`);
    assert.equal(await page.locator('input[name="role"]').inputValue(), 'player,staker');
    await player.focus();
    await page.keyboard.press('Space');
    assert.equal(await player.getAttribute('aria-pressed'), 'false', `${width}: keyboard toggle works`);
    await staker.click();
    assert.equal(await page.locator('input[name="role"]').inputValue(), '', `${width}: all roles can be cleared`);
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForFunction(() => document.querySelector('.vw-tile[data-highlighted="true"] video')?.currentTime > 0);
    const first = await snapshot(page);
    assert.equal(first.highlighted, 1, `${width}: one highlight`);
    assert.equal(first.overflow, false, `${width}: no horizontal overflow`);
    assert(first.form.left >= 0 && first.form.right <= width, `${width}: form within viewport`);
    assert(first.visibleClips.some((id) => id <= 3) && first.visibleClips.some((id) => id > 3), `${width}: both Tesoro and casual clips`);
    await page.screenshot({ path: `${out}/waitlist-${width}.png`, fullPage: true });

    const fade = await page.evaluate(() => {
      const face = document.querySelector('.vw-tile[data-highlighted="true"] .vw-face');
      const animation = face.getAnimations().find((a) => a.animationName === 'vw-spotlight');
      const duration = animation.effect.getTiming().duration;
      animation.pause();
      const samples = [0, 0.05, 0.2, 0.5, 0.85, 0.999].map((fraction) => {
        animation.currentTime = duration * fraction;
        return { fraction, opacity: Number(getComputedStyle(face).opacity), scale: new DOMMatrix(getComputedStyle(face).transform).m11 };
      });
      animation.currentTime = 0;
      animation.play();
      return samples;
    });
    assert.equal(fade[0].opacity, 0.4, `${width}: highlight starts dim`);
    assert(fade[1].opacity > 0.4 && fade[1].opacity < 1 && fade[1].scale > 1 && fade[1].scale < 1.04, `${width}: smooth fade and scale in`);
    assert.equal(fade[2].opacity, 1);
    assert.equal(fade[3].opacity, 1);
    assert(fade[4].opacity > 0.4 && fade[4].opacity < 1, `${width}: smooth fade out`);
    assert(fade[5].opacity < 0.401, `${width}: exit completes before handoff`);
    await page.evaluate(() => {
      window.wlTransitions = [];
      let previous = document.querySelector('.vw-tile[data-highlighted="true"]').dataset.tile;
      new MutationObserver(() => {
        const id = document.querySelector('.vw-tile[data-highlighted="true"]')?.dataset.tile;
        if (id && id !== previous) {
          window.wlTransitions.push({ id, time: performance.now() });
          previous = id;
        }
      }).observe(document.querySelector('.vw'), { subtree: true, attributes: true, attributeFilter: ['data-highlighted'] });
    });

    const seen = new Set();
    let previous = first;
    for (let n = 0; n < 18; n++) {
      await page.waitForTimeout(400);
      const sample = await snapshot(page);
      assert.equal(sample.highlighted, 1, `${width}: exclusive highlight at sample ${n}`);
      assert(sample.x > previous.x, `${width}: track moves right`);
      assert(sample.y < previous.y, `${width}: track moves up`);
      assert.equal(sample.content.left, first.content.left, `${width}: signup stays horizontally fixed`);
      assert.equal(sample.content.top, first.content.top, `${width}: signup stays vertically fixed`);
      assert(sample.playing > 0 && sample.playing <= (width <= 640 ? 6 : 10), `${width}: playback cap`);
      assert.deepEqual(sample.brokenMedia, [], `${width}: all gameplay loads`);
      seen.add(sample.id);
      previous = sample;
    }
    assert(seen.size > 1, `${width}: spotlight changes tiles`);
    const transitions = await page.evaluate(() => window.wlTransitions);
    assert(transitions.length >= 2, `${width}: multiple complete spotlight cycles`);
    for (let n = 1; n < transitions.length; n++) {
      const interval = transitions[n].time - transitions[n - 1].time;
      assert(interval >= 2920 && interval < 3500, `${width}: constant three-second cadence, got ${interval} ms`);
    }

    await page.getByRole("button", { name: "Pause motion" }).click();
    await page.waitForFunction(() => document.querySelector('.vw').dataset.motion === "paused");
    // Wait for the compositor to apply animation-play-state before comparing rendered transforms.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const paused = await snapshot(page);
    await page.waitForTimeout(700);
    const pausedAgain = await snapshot(page);
    assert.equal(pausedAgain.x, paused.x, `${width}: paused track is still`);
    assert.equal(pausedAgain.y, paused.y, `${width}: paused vertical drift is still`);
    assert.equal(pausedAgain.id, paused.id, `${width}: pausing does not select a new tile`);
    assert.equal(pausedAgain.opacity, paused.opacity, `${width}: paused fade is still`);
    assert.equal(pausedAgain.playing, 0, `${width}: paused videos are still`);
    assert.equal(pausedAgain.highlighted, 1);
    await page.getByRole("button", { name: "Resume motion" }).click();
    await page.waitForFunction(() => document.querySelector('.vw').dataset.motion === "running");
    await page.evaluate(() => scrollTo(0, 0));

    // Run a real iteration boundary with a freshly selected tile and an unfinished fade cycle.
    const oldId = await page.evaluate(() => {
      const track = document.querySelector('.vw-track').getAnimations()[0];
      track.currentTime = track.effect.getTiming().duration - 1200;
      const active = document.querySelector('.vw-tile[data-highlighted="true"]');
      const fade = active.querySelector('.vw-face').getAnimations()[0];
      fade.currentTime = fade.effect.getTiming().duration - 1;
      return active.dataset.tile;
    });
    await page.waitForFunction((old) => document.querySelector('.vw-tile[data-highlighted="true"]').dataset.tile !== old, oldId);
    // A selected CSS animation can still be pending its first rendered frame (especially while videos decode).
    // Measure elapsed fade time only after its timeline has actually started.
    await page.waitForFunction(() => {
      const fade = document.querySelector('.vw-tile[data-highlighted="true"] .vw-face').getAnimations()[0];
      return fade && !fade.pending && fade.startTime !== null && fade.currentTime > 0;
    });
    const beforeWrap = await snapshot(page);
    await page.waitForTimeout(1350);
    const afterWrap = await snapshot(page);
    const expectedId = beforeWrap.id.startsWith('lead-') ? beforeWrap.id.replace('lead-', '0-') : beforeWrap.id.replace(/^0-/, '1-');
    assert.equal(afterWrap.id, expectedId, `${width}: spotlight transfers to identical loop copy`);
    assert(afterWrap.fadeTime > beforeWrap.fadeTime + 1000, `${width}: wrapping preserves fade progress: ${JSON.stringify({ beforeWrap, afterWrap })}`);
    assert(afterWrap.activeX > beforeWrap.activeX && afterWrap.activeX - beforeWrap.activeX < 55, `${width}: no horizontal jump at wrap`);
    assert(afterWrap.activeY < beforeWrap.activeY && beforeWrap.activeY - afterWrap.activeY < 30, `${width}: no vertical jump at wrap`);

    // Inspect the complete loop, including the handoff, with geometry from the actual browser.
    const coverage = await page.evaluate(() => {
      const animation = document.querySelector('.vw-track').getAnimations()[0];
      const duration = animation.effect.getTiming().duration;
      animation.pause();
      const checks = [];
      const movement = [1000, 2000, 3000].map((time) => {
        animation.currentTime = time;
        const transform = new DOMMatrix(getComputedStyle(document.querySelector('.vw-track')).transform);
        return { x: transform.m41, y: transform.m42 };
      });
      const a = movement[1], b = movement[0], c = movement[2];
      checks.push(a.x > b.x && a.y < b.y);
      checks.push(Math.abs((a.x - b.x) - (c.x - a.x)) < 0.02 && Math.abs((a.y - b.y) - (c.y - a.y)) < 0.02);
      checks.push(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - 28) < 0.02);
      for (const fraction of [0, 0.25, 0.5, 0.75, 0.9999, 1]) {
        animation.currentTime = duration * fraction;
        const rects = [...document.querySelectorAll('.vw-tile')].map((t) => t.getBoundingClientRect());
        for (const y of [0, innerHeight / 2, innerHeight - 1]) {
          // Eight-pixel gutters between hexagons are intentional; a missing column is not.
          const row = rects.filter((r) => r.top <= y + 8 && r.bottom >= y - 8);
          checks.push(row.some((r) => r.left <= 0 && r.right > 0) && row.some((r) => r.left < innerWidth && r.right >= innerWidth));
        }
      }
      animation.currentTime = duration * 0.9999;
      checks.push(document.querySelector('.vw-tile[data-tile^="lead-"]').getBoundingClientRect().left < 0);
      animation.play();
      return checks;
    });
    assert(coverage.every(Boolean), `${width}: both sides covered throughout loop`);

    await page.locator('#wl-email').fill('invalid');
    assert.equal(await page.locator('#wl-email').evaluate((input) => input.checkValidity()), false);
    await page.locator('#wl-email').fill('honeycomb-check@example.com');
    await player.click();
    await studio.click();
    await page.locator('#wl-studio').fill('Browser test studio');
    await page.locator('input[name="company"]').evaluate((input) => { input.value = "verification"; });
    const submitted = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === '/');
    await page.getByRole('button', { name: 'Join the waitlist' }).click();
    const payload = (await submitted).postData();
    assert.match(payload, /player,studio/, `${width}: selected roles sent in the actual form request`);
    assert.match(payload, /Browser test studio/, `${width}: studio details sent in the actual form request`);
    await page.waitForSelector('.wl-done-title');
    assert.match(await page.locator('.wl-done-title').innerText(), /on the list/i);
    await page.screenshot({ path: `${out}/success-${width}.png`, fullPage: true });
    results.push({ viewport: [width, height], roles: 'multi-select, deselect, keyboard, optional studio, and submitted metadata passed', first, fade, transitions, highlightsObserved: [...seen], loopAndVelocityChecks: coverage.length, success: 'honeypot; no email stored' });
    await context.close();
  }

  for (const mode of ['reduced-motion', 'save-data']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: mode === 'reduced-motion' ? 'reduce' : 'no-preference' });
    if (mode === 'save-data') await context.addInitScript(() => {
      Object.defineProperty(navigator, 'connection', { value: Object.assign(new EventTarget(), { saveData: true }) });
    });
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('.vw[data-motion="paused"]');
    const first = await snapshot(page);
    await page.waitForTimeout(1000);
    const next = await snapshot(page);
    assert.equal(first.x, next.x, `${mode}: no drift`);
    assert.equal(first.y, next.y, `${mode}: no vertical drift`);
    assert.equal(next.playing, 0, `${mode}: no video playback`);
    assert.equal(next.highlighted, 1, `${mode}: one static highlight`);
    assert.equal(await page.locator('.vw video[src]').count(), 0, `${mode}: no media downloads`);
    await page.screenshot({ path: `${out}/${mode}.png`, fullPage: true });
    results.push({ mode, passed: true });
    await context.close();
  }
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  await writeFile(`${out}/verification.json`, JSON.stringify({ base, results, errors }, null, 2));
  console.log(`PASS: ${results.length} viewport/motion scenarios; playback, single fading highlight, steady cadence, constant diagonal speed, loop coverage, pause/resume, and honeypot signup. Evidence: ${out}`);
} finally {
  await browser.close();
}
