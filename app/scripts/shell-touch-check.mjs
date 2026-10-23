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
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.addInitScript(() => {
    window.tapEvents = [];
    for (const name of ["pointerdown", "pointerup", "pointercancel", "click"]) {
      document.addEventListener(name, (e) => window.tapEvents.push({ name, pointerType: e.pointerType, time: performance.now() }), true);
    }
  });
  async function visit(path = "/play") {
    await page.goto(`${base}${path}?dev=demo`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.locator(".pchest:not(.skel)").waitFor({ timeout: 60000 });
    await page.locator(".acct-btn").waitFor();
    await page.waitForTimeout(400);
  }
  async function tap(name, selector, { nav = false, reduced = false, disabled = false } = {}) {
    await page.locator(selector).evaluate((el) => {
      window.tapFrames = [];
      window.tapEvents = [];
      window.tapRecording = true;
      const start = performance.now();
      const sample = () => {
        const icon = el.querySelector(".nav-icon") ?? el;
        const svg = el.querySelector(".nav-icon > svg");
        const scale = (node) => node ? new DOMMatrixReadOnly(getComputedStyle(node).transform).a : 1;
        window.tapFrames.push({
          ms: performance.now() - start, time: performance.now(),
          pressed: el.dataset.pressed === "true",
          scale: scale(icon), iconScale: scale(svg),
          transform: getComputedStyle(icon).transform,
          current: el.getAttribute("aria-current"), connected: el.isConnected,
          animations: el.getAnimations({ subtree: true }).map((a) => a.animationName).filter(Boolean),
        });
        if (window.tapRecording && performance.now() - start < 90000) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    if (disabled) {
      const box = await page.locator(selector).boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    } else await page.tap(selector);
    if (nav) await page.waitForFunction((s) => document.querySelector(s)?.getAttribute("aria-current") === "page", selector, { timeout: 60000 });
    await page.waitForTimeout(700);
    await page.evaluate(() => { window.tapRecording = false; });
    const result = await page.evaluate(() => ({ frames: window.tapFrames, events: window.tapEvents }));
    results.push({ name, ...result });
    assert.ok(result.events.some((e) => e.name === "pointerdown" && e.pointerType === "touch"), `${name}: genuine touch pointer`);
    assert.ok(result.frames.every((f) => f.connected), `${name}: control survives route/render changes`);
    if (reduced || disabled) {
      assert.ok(result.frames.every((f) => Math.abs(f.scale - 1) < 0.001 && Math.abs(f.iconScale - 1) < 0.001), `${name}: must stay still`);
      if (disabled) assert.ok(result.frames.every((f) => !f.pressed), `${name}: disabled cannot press`);
    } else {
      assert.ok(result.frames.some((f) => f.pressed && f.scale < 0.99), `${name}: must visibly press during/after touch`);
      const up = result.events.find((e) => e.name === "pointerup");
      assert.ok(up, `${name}: touch released`);
      assert.ok(result.frames.some((f) => f.time > up.time && f.pressed && f.scale < 0.99), `${name}: visible feedback immediately after tap`);
      if (nav) {
        assert.ok(result.frames.some((f) => f.animations.includes("nav-pop")), `${name}: selected icon must pop`);
        assert.ok(result.frames.some((f) => f.animations.includes("nav-bar-in")), `${name}: selected bar must grow`);
        assert.ok(result.frames.some((f) => f.iconScale > 1.01), `${name}: sample the actual selected overshoot`);
      }
    }
    assert.equal(await page.locator(selector).getAttribute("data-pressed"), null, `${name}: press must clear`);
    console.log(`PASS ${name}: scale ${Math.min(...result.frames.map((f) => f.scale)).toFixed(3)}; icon max ${Math.max(...result.frames.map((f) => f.iconScale)).toFixed(3)}`);
  }

  await visit();
  await page.locator(".pc-chest-image").evaluate(async (el) => { await el.decode(); });
  assert.equal(await page.locator(".pc-chest-image").evaluate((el) => el.getBoundingClientRect().width), 28);
  await page.screenshot({ path: join(out, "play-loaded-390.png") });
  await page.locator(".topbar").screenshot({ path: join(out, "topbar-390.png") });
  // Compile/load every destination first: cold Next dev compilation can stall the main
  // thread across the entire overshoot, leaving no frame available to sample.
  for (const href of ["/matches", "/friends", "/leaderboard", "/vault", "/play"]) {
    await page.tap(`.bottom-nav a[href="${href}"]`);
    await page.waitForFunction((h) => document.querySelector(`.bottom-nav a[href="${h}"]`)?.getAttribute("aria-current") === "page", href, { timeout: 60000 });
    await page.waitForTimeout(700);
  }
  for (const href of ["/matches", "/friends", "/play", "/leaderboard", "/vault", "/matches"]) {
    await tap(`nav-${href.slice(1)}`, `.bottom-nav a[href="${href}"]`, { nav: true });
  }
  // Simulate a browser that never paints native :active: the pointer attribute must suffice.
  await page.addStyleTag({ content: '.bottom-nav a:active:not([data-pressed="true"]) .nav-icon { transform: none !important; } .topbar :is(button,a):active:not([data-pressed="true"]) { transform: none !important; }' });
  await tap("nav-without-native-active", '.bottom-nav a[href="/play"]', { nav: true });
  await tap("pool-without-native-active", ".topbar a.pchest");
  await tap("gemas-without-native-active", ".topbar a.gpill");
  await page.keyboard.press("Escape");
  await page.locator("dialog.sheet[open]").waitFor({ state: "hidden" });
  await tap("avatar-without-native-active", ".topbar .acct-btn");
  await page.keyboard.press("Escape");
  await tap("menu-without-native-active", ".topbar .menu-btn");
  await page.keyboard.press("Escape");
  await page.locator("dialog.drawer[open]").waitFor({ state: "hidden" });
  await page.locator('.topbar .menu-btn').evaluate((el) => { el.disabled = true; });
  await tap("disabled-menu", '.topbar .menu-btn', { disabled: true });
  await page.locator('.topbar .menu-btn').evaluate((el) => { el.disabled = false; });

  const cdp = await page.context().newCDPSession(page);
  const navSelector = '.bottom-nav a[href="/matches"]';
  const box = await page.locator(navSelector).boundingBox();
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(95);
  assert.equal(await page.locator(navSelector).getAttribute("data-pressed"), "true");
  await page.screenshot({ path: join(out, "nav-touch-held-390.png"), animations: "allow" });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.screenshot({ path: join(out, "nav-touch-release-390.png"), animations: "allow" });
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(out, "nav-touch-settled-390.png"), animations: "allow" });
  // A scroll gesture and a cancelled touch must never leave a control pressed.
  for (const mode of ["move", "cancel"]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    if (mode === "move") await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y - 45 }] });
    else await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    assert.equal(await page.locator(navSelector).getAttribute("data-pressed"), null, `${mode}: press clears`);
    if (mode === "move") await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    results.push({ name: `${mode}-clears-press`, passed: true });
  }
  await page.locator('.topbar .menu-btn').evaluate((el) => el.setAttribute("aria-disabled", "true"));
  await tap("aria-disabled-menu", '.topbar .menu-btn', { disabled: true });
  await page.locator('.topbar .menu-btn').evaluate((el) => el.removeAttribute("aria-disabled"));
  await page.keyboard.press("Escape");
  await page.locator("dialog.drawer[open]").waitFor({ state: "hidden" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await tap("reduced-nav", '.bottom-nav a[href="/play"]', { reduced: true });
  await tap("reduced-pool", ".topbar a.pchest", { reduced: true });
  await tap("reduced-avatar", ".topbar .acct-btn", { reduced: true });
  await page.keyboard.press("Escape");

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await desktop.goto(`${base}/play?dev=demo`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await desktop.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  const chest = desktop.locator(".pc-chest-image");
  await chest.waitFor({ timeout: 60000 });
  await chest.evaluate(async (el) => { await el.decode(); });
  assert.equal(await chest.evaluate((el) => el.getBoundingClientRect().width), 40);
  await desktop.screenshot({ path: join(out, "play-1440.png") });
  await desktop.locator(".topbar").screenshot({ path: join(out, "topbar-1440.png") });
  results.push({ name: "chest-image-sizes", phone: 28, desktop: 40 });

  // Exercise the real usePool poll and PoolChest effect with an intercepted public RPC read.
  const { PublicKey } = require("@solana/web3.js");
  const core = new PublicKey(require("../src/lib/chain/idl/tesoro_core.json").address);
  const authority = PublicKey.findProgramAddressSync([Buffer.from("leaderboard")], core)[0];
  const poolAddress = PublicKey.findProgramAddressSync([Buffer.from("account"), authority.toBuffer()], core)[0].toBase58();
  const growth = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await growth.clock.install();
  let poolAmount = 1200n;
  let poolReads = 0;
  await growth.route("**/*", async (route) => {
    const req = route.request();
    const body = req.method() === "POST" ? req.postDataJSON() : null;
    if (body?.method !== "getAccountInfo" || body.params[0] !== poolAddress) return route.continue();
    poolReads++;
    const data = Buffer.alloc(77);
    data.writeBigUInt64LE(poolAmount, 61);
    await route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value: { data: [data.toString("base64"), "base64"], executable: false, lamports: 1, owner: core.toBase58(), rentEpoch: 0 } } } });
  });
  await growth.goto(`${base}/play?dev=demo`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await growth.locator(".pc-chest-image").waitFor({ timeout: 60000 });
  await growth.evaluate(() => {
    window.chestPops = [];
    const seen = new WeakSet();
    new MutationObserver(() => {
      const el = document.querySelector(".pc-chest-image.pop");
      if (el && !seen.has(el)) {
        seen.add(el);
        window.chestPops.push({ animation: getComputedStyle(el).animationName, reduced: matchMedia("(prefers-reduced-motion: reduce)").matches });
      }
    }).observe(document.querySelector(".pchest"), { subtree: true, childList: true, attributes: true });
  });
  poolAmount = 1400n;
  await growth.clock.fastForward(60100);
  await growth.waitForFunction(() => window.chestPops.length > 0);
  assert.ok((await growth.evaluate(() => window.chestPops)).some((p) => p.animation === "pool-chest-pop"));
  await growth.locator(".pc-chest-image.pop").waitFor({ state: "detached" });
  poolAmount = 1600n;
  await growth.clock.fastForward(60100);
  await growth.waitForFunction(() => window.chestPops.length > 1);
  const pops = await growth.evaluate(() => window.chestPops);
  assert.ok(pops.filter((p) => p.animation === "pool-chest-pop").length >= 2, "growth must replay the image pop");
  await growth.locator(".pc-chest-image.pop").waitFor({ state: "detached" });
  await growth.emulateMedia({ reducedMotion: "reduce" });
  poolAmount = 1800n;
  await growth.clock.fastForward(60100);
  await growth.waitForFunction(() => window.chestPops.some((p) => p.reduced));
  assert.ok((await growth.evaluate(() => window.chestPops)).filter((p) => p.reduced).every((p) => p.animation === "none"));
  results.push({ name: "pool-growth-replay-and-reduced-motion", poolReads, pops: await growth.evaluate(() => window.chestPops) });
  console.log("PASS pool growth: real poll/effect replays the chest pop; reduced motion stays still");
} finally {
  await writeFile(join(out, "touch-results.json"), JSON.stringify(results, null, 2));
  await browser.close();
}
