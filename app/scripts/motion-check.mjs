import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const base = process.env.BASE ?? "http://localhost:3391";
const out = process.env.OUT ?? join(homedir(), ".cache/tesoro-tmp/mobile-first-round6/after");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
  args: ["--no-sandbox"],
});
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  async function visit(path) {
    await page.goto(`${base}${path}${path.includes("?") ? "&" : "?"}dev=demo`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.locator(".bottom-nav").waitFor();
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.waitForTimeout(500);
  }
  async function press(name, target, measured = target, expected = 0.96, screenshot = true) {
    await target.scrollIntoViewIfNeeded();
    const r = await target.boundingBox();
    assert.ok(r, `${name} must be visible`);
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    try {
      await page.waitForTimeout(110);
      const values = await measured.evaluate((el) => {
        const s = getComputedStyle(el);
        const m = new DOMMatrixReadOnly(s.transform);
        return { transform: s.transform, scale: Math.hypot(m.a, m.b), filter: s.filter, transition: s.transition, active: el.matches(":active") };
      });
      results.push({ name, ...values });
      assert.ok(Math.abs(values.scale - expected) < 0.012, `${name}: expected ${expected}, got ${values.transform}`);
      if (name.includes("disabled")) {
        assert.equal(values.filter, "none", `${name} must not brighten or dim`);
        assert.equal(values.transition, "none", `${name} must not animate when disabled`);
      }
      if (screenshot) await page.screenshot({ path: join(out, `${name}.png`), animations: "allow" });
      console.log(`PASS: ${name} ${values.transform}`);
    } finally {
      // Cancel activation so a proof of a held link doesn't navigate away.
      await page.mouse.move(1, 1);
      await page.mouse.up();
    }
    await page.waitForTimeout(350);
  }
  await visit("/play");
  const nav = page.locator('.bottom-nav a[href="/matches"]');
  await press("nav-mid-press", nav, nav.locator(".nav-icon"), 0.85);
  await press("game-tile-mid-press", page.locator("a.game-tile").first(), undefined, 0.98);
  await page.evaluate(() => {
    window.navMotion = [];
    new MutationObserver(() => {
      const current = document.querySelector('.bottom-nav a[aria-current="page"]');
      window.navMotion.push(...current.getAnimations({ subtree: true }).map((a) => a.animationName).filter(Boolean));
    }).observe(document.querySelector(".bottom-nav"), { subtree: true, childList: true, attributes: true });
  });
  await nav.click();
  await page.waitForURL("**/matches*");
  const navMotion = await page.evaluate(() => window.navMotion);
  assert.ok(navMotion.includes("nav-pop"), "newly active tab must pop");
  assert.ok(navMotion.includes("nav-bar-in"), "active bar must grow from its centre");
  results.push({ name: "nav-selection", animations: [...new Set(navMotion)] });
  await visit("/vault");
  const button = page.getByRole("button", { name: "Buy Gemas", exact: true }).filter({ visible: true });
  await press("button-mid-press", button);
  await visit("/matches");
  await press("match-card-mid-press", page.locator(".mb-hit").first(), page.locator(".mb:has(.mb-hit)").first(), 0.98);
  await press("result-filter", page.locator(".mh-result").first(), undefined, 0.96, false);
  await press("game-filter", page.locator(".mh-tabs a").first(), undefined, 0.96, false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await press("reduced-nav", nav, nav.locator(".nav-icon"), 1, false);
  await press("reduced-match", page.locator(".mb-hit").first(), page.locator(".mb:has(.mb-hit)").first(), 1, false);
  await visit("/vault");
  await press("reduced-button", button, button, 1, false);
  const toggle = page.getByRole("switch", { name: "Pro view" });
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  assert.equal(await toggle.locator("span").evaluate((el) => getComputedStyle(el).transform), "matrix(1, 0, 0, 1, 26, 0)");
  await toggle.click();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await press("pro-switch-squash", toggle, toggle.locator("span"), 1.12, false);
  await button.evaluate((el) => el.setAttribute("aria-disabled", "true"));
  await press("aria-disabled-button", button, button, 1, false);
  await button.evaluate((el) => { el.removeAttribute("aria-disabled"); el.disabled = true; });
  await press("disabled-button", button, button, 1, false);
  await button.evaluate((el) => { el.disabled = false; });
  await page.keyboard.press("Tab");
  await button.focus();
  const focusRing = await button.evaluate((el) => {
    const s = getComputedStyle(el, "::after");
    return { visible: el.matches(":focus-visible"), content: s.content, insetRing: s.getPropertyValue("--r").trim() };
  });
  assert.equal(focusRing.visible, true);
  assert.equal(focusRing.content, '\"\"');
  assert.equal(focusRing.insetRing, "2px", "money button keeps its cut focus ring");
  results.push({ name: "button-keyboard-focus", ...focusRing });
  await button.click();
  const sheet = page.locator("dialog.sheet[open]");
  await sheet.waitFor();
  const sheetMotion = await sheet.evaluate((el) => {
    const s = getComputedStyle(el);
    return { transition: s.transition, ring: getComputedStyle(el, "::after").content };
  });
  assert.ok(sheetMotion.transition.includes("0.18s"), "sheet must open in 180 ms");
  assert.equal(sheetMotion.ring, '\"\"', "sheet cut ring must remain");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  results.push({ name: "sheet-open-close", ...sheetMotion });
  await visit("/play/practice");
  const menuButton = page.getByRole("button", { name: "Game menu", exact: true });
  await menuButton.waitFor({ timeout: 90000 });
  // The server-rendered header can precede hydration and Arena's cover effect.
  // Wait for its final position before dispatching any input.
  await page.locator("html.game-full").waitFor({ timeout: 90000 });
  await press("game-menu-button", menuButton, menuButton, 0.96, false);
  await menuButton.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  assert.equal(await menu.evaluate((el) => getComputedStyle(el).animationName), "micro-menu-in");
  assert.equal(await menu.evaluate((el) => el.parentElement === document.body), true, "menu must remain portalled");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await menuButton.evaluate((el) => el === document.activeElement), true, "Escape restores menu focus");
  results.push({ name: "game-menu-open-close", animation: "micro-menu-in", portalAndFocus: true });
  await page.locator(".bp-slot:not(:disabled)").first().waitFor({ timeout: 90000 });
  assert.equal(await page.locator(".bp-slot:not(:disabled)").first().evaluate((el) => getComputedStyle(el).transitionProperty.includes("transform")), false, "dragging a piece must keep its own feedback");
  assert.equal(await page.locator(".bp-cell").first().evaluate((el) => getComputedStyle(el).transitionProperty.includes("transform")), false, "board cells must keep their own feedback");
  await press("practice-pause", page.getByRole("button", { name: "Pause", exact: true }), undefined, 0.96, false);
  results.push({ name: "block-burst-board-and-pieces", sharedTransformTransition: false });
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await desktop.goto(`${base}/play?dev=demo`);
  const tile = desktop.locator("a.game-tile").first();
  // Hydration can lag the first paint while the dev server compiles game chunks.
  await desktop.waitForFunction(() => Object.keys(document.querySelector("a.game-tile") ?? {}).some((k) => k.startsWith("__reactProps")), null, { timeout: 90000 });
  // Demo data can reposition the grid after hydration; move onto its current box each time.
  let rotated = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    await desktop.mouse.move(1, 1);
    await tile.hover({ position: { x: 40, y: 40 } });
    await desktop.waitForTimeout(250);
    rotated = await tile.evaluate((el) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return Math.abs(m.m13) + Math.abs(m.m23) > 0.001;
    });
    if (rotated) break;
  }
  const tilted = await tile.evaluate((el) => getComputedStyle(el).transform);
  assert.ok(rotated, `desktop hover must actually rotate, beyond the resting perspective: ${tilted}`);
  assert.notEqual(await tile.evaluate((el) => el.style.getPropertyValue("--rx")), "", "desktop pointer handler must actually rotate the tile");
  results.push({ name: "desktop-hover-tilt", transform: tilted });
  await desktop.screenshot({ path: join(out, "desktop-hover.png") });
  console.log(`PASS: ${results.length} motion checks; reduced-motion toggle changes instantly.`);
} finally {
  await writeFile(join(out, "computed-transforms.json"), JSON.stringify(results, null, 2) + "\n");
  await browser.close();
}
