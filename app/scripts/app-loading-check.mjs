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
  const seed = await browser.newPage();
  await seed.goto(`${base}/play?dev=demo`, { waitUntil: "domcontentloaded", timeout: 90000 });
  const account = await seed.locator('a[href^="/account/"]').first().getAttribute("href");
  await seed.close();
  const screens = [
    ["play", "/play", ".continue[aria-busy=true]"],
    ...["block-puzzle", "holdem", "trading-duel", "vanguard"].map((g) => [`game-${g}`, `/play/${g}`, ".gp-panel .mb.skel"]),
    ["matches", "/matches", ".mh-page .mb.skel"],
    ["friends", "/friends", ".fr-page[aria-busy=true]"],
    ["leaderboard", "/leaderboard", ".lb-band.skel"],
    ["vault-simple", "/vault", ".wl-hero[aria-busy=true] .wl-figure-skel"],
    ["vault-pro", "/vault", ".wl-hero[aria-busy=true] .wl-figure-skel"],
    ["backing", "/backing", ".rq.skel"],
    ["account", account, ".pa[aria-busy=true]"],
    ["help", "/help", null], ["docs", "/docs", null],
  ];
  for (const [name, path, selector] of screens) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const held = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route("**/*", async (route) => {
      const request = route.request();
      let rpc = false;
      try { rpc = !!request.postDataJSON()?.jsonrpc; } catch { /* Static requests have no JSON body. */ }
      const url = new URL(request.url());
      if (rpc || /^\/api\/(chain\/|leaderboard|friends)/.test(url.pathname)) {
        held.push(rpc ? "RPC" : url.pathname);
        await gate;
        await route.abort();
      } else await route.continue();
    });
    try {
      // A signed-in dev wallet without the synchronous demo fixture exercises real pending reads.
      await page.goto(`${base}${path}?dev=round9-loading`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      if (name.startsWith("vault")) {
        const pro = page.getByRole("switch", { name: "Pro view" });
        await pro.waitFor();
        if (name.endsWith("pro")) await pro.click();
      }
      if (selector) {
        for (let i = 0; held.length === 0 && i < 150; i++) await page.waitForTimeout(100);
      }
      await page.waitForTimeout(3000);
      const skeleton = selector ? await page.locator(selector).count() : null;
      const shell = name === "docs" ? null : await page.locator(".pchest.skel").count();
      const result = { name, path, held: held.length, heldPaths: held, skeleton, shell, scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth) };
      results.push(result);
      await page.screenshot({ path: join(out, `loading-${name}-390.png`), fullPage: true });
      console.log(`${selector && !skeleton ? "FAIL" : "PASS"} ${name}: ${JSON.stringify(result)}`);
    } finally {
      release();
      await page.close();
    }
  }
  await writeFile(join(out, "loading-results.json"), JSON.stringify(results, null, 2));
  assert.ok(results.every((r) => r.skeleton === null || (r.skeleton > 0 && r.held > 0)), "every data screen has its own skeleton while actual reads are held");
  assert.ok(results.every((r) => r.shell === null || r.shell > 0), "the top bar also stays in its loading state");
} finally {
  await browser.close();
}
