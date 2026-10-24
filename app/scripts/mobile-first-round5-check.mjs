/** Verify round 5 against the existing dev server; starts no server or build.
 * PW=/path/to/playwright-core BASE=http://localhost:3391 OUT=/path/to/after node scripts/mobile-first-round5-check.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const base = process.env.BASE ?? "http://localhost:3391";
const out = process.env.OUT ?? join(homedir(), ".cache/tesoro-tmp/mobile-first-round5/after");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"), headless: true });
const results = [];
const diagnostics = [];

async function capture(page, name) {
  await page.waitForFunction(() => document.querySelector(".topbar .gpill b")?.textContent === "5,000", undefined, { timeout: 60000 });
  await page.locator(".topbar .pchest:not(.skel)").waitFor({ timeout: 60000 });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(out, name) });
}

async function cardLayout(page) {
  return page.locator(".wl-hero").evaluate((card) => {
    const rect = (e) => e.getBoundingClientRect().toJSON();
    const box = rect(card);
    const style = getComputedStyle(card);
    const inset = box.width < 600 ? 13 : 30;
    return {
      box, inset, padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      figureSize: getComputedStyle(card.querySelector(".wl-total-fig b")).fontSize,
      total: rect(card.querySelector(".wl-total")),
      rows: [...card.querySelectorAll(".wl-win")].map((row) => ({
        label: row.getAttribute("aria-label"), box: rect(row),
        action: row.querySelector(".btn") ? rect(row.querySelector(".btn")) : null,
        actionDisabled: row.querySelector(".btn")?.disabled,
      })),
    };
  });
}

function checkCard(layout) {
  const { box, inset, total, rows } = layout;
  // Leave a readable gap between contents and the innermost crown frame, on all four sides.
  for (const content of [total, ...rows.map((row) => row.box)]) {
    assert(content.x >= box.x + inset + 10, `Contents touch the left crown: ${JSON.stringify(layout)}`);
    assert(content.right <= box.right - inset - 10, "Contents touch the right crown");
    assert(content.y >= box.y + inset + 10, "Contents touch the top crown");
    assert(content.bottom <= box.bottom - inset - 10, "Contents touch the bottom crown");
  }
  for (const row of rows) if (row.action) {
    assert(row.action.x >= row.box.x && row.action.right <= row.box.right + 1, `${row.label} action overflows`);
  }
}

async function checkActions(page, width, layout) {
  const actions = page.locator(".vt-head-actions:visible");
  assert.equal(await actions.count(), 1, "Must have one visible set of money actions");
  assert.deepEqual((await actions.locator(".btn").allTextContents()).map((s) => s.trim()), ["Buy Gemas", "Borrow Gemas"]);
  const box = await actions.boundingBox();
  if (width < 1024) assert(box.y >= layout.box.bottom, "Phone/tablet actions must follow the balance card");
  else {
    assert(box.y + box.height <= layout.box.y, "Desktop actions must stay above the card");
    assert(await page.getByRole("heading", { name: "Vault", exact: true }).isVisible());
  }
  assert.equal(await actions.getByRole("link", { name: "Borrow Gemas", exact: true }).getAttribute("href"), "/backing?post=1");
}

async function checkNav(page, active) {
  const nav = page.getByRole("navigation", { name: "Main", exact: true });
  const layout = await nav.locator("a").evaluateAll((tabs) => tabs.map((tab) => {
    const icon = tab.querySelector(".nav-icon");
    const style = getComputedStyle(tab);
    const r = icon.getBoundingClientRect();
    return { href: tab.getAttribute("href"), active: tab.getAttribute("aria-current"), color: style.color, shadow: style.boxShadow,
      iconColor: getComputedStyle(icon.querySelector("svg")).color, iconY: r.y, iconWidth: r.width, iconHeight: r.height,
      raised: !!tab.querySelector(".nav-play-tile"), emerald: getComputedStyle(document.documentElement).getPropertyValue("--em-hi").trim() };
  }));
  assert.equal(layout.length, 5);
  assert.equal(layout[2].href, "/play", "Play must remain in the centre");
  assert(layout.every((tab) => !tab.raised && tab.iconWidth === 22 && tab.iconHeight === 22 && tab.iconY === layout[0].iconY), "All tabs need the same icon layout");
  const selected = layout.filter((tab) => tab.active === "page");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].href, active);
  const emerald = await page.evaluate((color) => {
    const el = document.createElement("span"); el.style.color = color; document.body.append(el);
    const rgb = getComputedStyle(el).color; el.remove(); return rgb;
  }, selected[0].emerald);
  assert.equal(selected[0].color, emerald);
  assert.equal(selected[0].iconColor, emerald);
  assert(selected[0].shadow.includes(emerald), "Active top bar must use emerald");
  return layout;
}

try {
  for (const width of [632, 320, 390, 768, 1023, 1024, 1440]) {
    const name = `vault-${width}`;
    const phone = width < 1024;
    const page = await browser.newPage({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
    page.on("pageerror", (e) => diagnostics.push({ name, type: "pageerror", text: e.message }));
    page.on("console", (msg) => { if (msg.type() === "error") diagnostics.push({ name, type: "console", text: msg.text() }); });
    try {
      await page.goto(`${base}/vault?dev=demo`, { waitUntil: "domcontentloaded", timeout: 60000 });
      const toggle = page.getByRole("switch", { name: "Pro view", exact: true });
      await toggle.waitFor({ timeout: 60000 });
      await page.waitForFunction(() => document.querySelector(".wl-total-fig b")?.getAttribute("aria-busy") === "false");
      // Keep the app UI intact; suppress only Next's local development overlay in review images.
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      const dismiss = page.getByRole("button", { name: phone ? "Dismiss tip" : "Got it", exact: true });
      if (await dismiss.isVisible()) await dismiss.click();
      await page.mouse.move(0, 0);
      await page.evaluate(() => document.fonts.ready);
      const simple = await cardLayout(page);
      checkCard(simple);
      assert.deepEqual(simple.rows.map((row) => row.label), ["Winnings"]);
      await checkActions(page, width, simple);
      assert.equal(await page.locator(".vt-backing").count(), 0, "Demo Player has no own Requests");
      if (phone) await checkNav(page, "/vault");
      if (width === 390 || width === 1440) await capture(page, `vault-simple-${width}x${phone ? 844 : 900}.png`);
      await toggle.click();
      await page.mouse.move(0, 0);
      await page.waitForFunction(() => document.querySelectorAll(".wl-hero .wl-win").length === 3);
      await page.waitForTimeout(250);
      const pro = await cardLayout(page);
      checkCard(pro);
      assert.deepEqual(pro.rows.map((row) => row.label), ["Redeemable now", "Your pending", "Won pending"]);
      assert.equal(pro.figureSize, simple.figureSize);
      assert.deepEqual(pro.padding, simple.padding);
      assert.equal(pro.rows[1].action, null, "Own Pending must have no action");
      for (const label of ["Redeemable now", "Your pending", "Won pending"]) {
        assert(await page.getByRole("button", { name: `About ${label}`, exact: true }).isVisible());
      }
      await checkActions(page, width, pro);
      assert.equal(await page.locator(".wl-hero .wl-fold").count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Page overflows horizontally");
      await page.evaluate(() => window.scrollTo(0, 0));
      if (width === 390 || width === 1440) await capture(page, `vault-pro-${width}x${phone ? 844 : 900}.png`);
      results.push({ name, pass: true, simple, pro });
      console.log(`PASS ${name}`);
      if (width === 390) {
        await page.goto(`${base}/play?dev=demo`, { waitUntil: "domcontentloaded" });
        await page.locator(".bottom-nav").waitFor();
        await page.mouse.move(0, 0);
        await page.waitForTimeout(500);
        const nav = await checkNav(page, "/play");
        await capture(page, "play-390x844.png");
        results.push({ name: "play-390", pass: true, nav });
        console.log("PASS play-390");
      }
    } catch (e) {
      results.push({ name, pass: false, error: e.stack });
      console.error(`FAIL ${name}: ${e.message}`);
      await page.screenshot({ path: join(out, `${name}-failure.png`) }).catch(() => {});
    } finally { await page.close(); }
  }
  const signedOut = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await signedOut.goto(`${base}/vault?dev=out`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await signedOut.getByText("Your Gemas, deposits and winnings belong to your Account. Sign in to see them.").waitFor({ timeout: 60000 });
    assert.equal(await signedOut.locator(".vt-backing").count(), 0);
    results.push({ name: "vault-signed-out", pass: true });
    console.log("PASS vault-signed-out");
  } catch (e) {
    results.push({ name: "vault-signed-out", pass: false, error: e.stack });
    console.error(`FAIL vault-signed-out: ${e.message}`);
  } finally { await signedOut.close(); }
} finally { await browser.close(); }
await writeFile(join(out, "checks.json"), JSON.stringify({ results, diagnostics }, null, 2) + "\n");
console.log(`${results.filter((r) => r.pass).length} passed; ${results.filter((r) => !r.pass).length} failed; ${diagnostics.filter((e) => e.type === "pageerror").length} page errors`);
if (results.some((r) => !r.pass) || diagnostics.some((e) => e.type === "pageerror")) process.exitCode = 1;
