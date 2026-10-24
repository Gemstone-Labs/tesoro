import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const base = process.env.BASE ?? "http://localhost:3391";
const out = process.env.OUT ?? join(homedir(), ".cache/tesoro-tmp/mobile-first-round9/after");
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"), args: ["--no-sandbox"] });
const results = [];
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });
    for (const game of ["block-puzzle", "holdem", "trading-duel", "vanguard"]) {
      await page.goto(`${base}/play/${game}?dev=demo`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      await page.locator(".gp-panel .mb:not(.skel), .gp-panel .gp-empty").first().waitFor({ timeout: 60000 });
      await page.locator(".gp-hero-art").evaluate((img) => img.decode());
      await page.waitForTimeout(1000);
      const panel = await page.locator(".gp-hero-body").boundingBox();
      const recent = await page.locator("#gp-recent").boundingBox();
      if (width === 390) {
        const nav = await page.locator(".bottom-nav").boundingBox();
        const visibleBottom = nav?.y ?? 768;
        assert.ok(panel.y + panel.height < visibleBottom, `${game}: whole panel fits above navigation`);
        assert.ok(recent.y + recent.height < visibleBottom, `${game}: Recent Matches starts on the first screen`);
        assert.equal(await page.locator(".gp-hero-art").evaluate((el) => getComputedStyle(el).objectFit), "contain", "whole square art is preserved");
      }
      results.push({ game, width, panel, recent });
      await page.screenshot({ path: join(out, `game-${game}-${width}.png`) });
    }
    await page.goto(`${base}/vault?dev=demo`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.locator('.wl-hero[aria-busy="false"]').waitFor({ timeout: 60000 });
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    assert.ok(!(await page.locator(".wl-hero").innerText()).includes("Simulated yield"), "no duplicate yield line");
    await page.getByRole("button", { name: "About Gemas", exact: true }).click();
    await page.getByRole("tooltip").filter({ hasText: "1 month = 10 min" }).waitFor();
    await page.mouse.click(1, 1);
    await page.screenshot({ path: join(out, `vault-simple-${width}.png`) });
    await page.getByRole("switch", { name: "Pro view" }).click();
    assert.ok(!(await page.locator(".wl-hero").innerText()).includes("Simulated yield"));
    await page.screenshot({ path: join(out, `vault-pro-${width}.png`) });
    await page.close();
  }
  await writeFile(join(out, "visual-results.json"), JSON.stringify(results, null, 2));
  console.log(`PASS: ${results.length} game layouts; Simple/Pro card and tooltip verified at phone and desktop sizes`);
} finally {
  await browser.close();
}
