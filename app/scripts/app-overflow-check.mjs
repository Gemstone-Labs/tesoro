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
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
  args: ["--no-sandbox"],
});
const results = [];
try {
  for (const width of [320, 360, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    // Only Friends uses an API in demo mode. Keep the long add-me URL and private-list UI deterministic.
    await page.route("**/api/friends", async (route) => {
      const body = route.request().postDataJSON();
      if (body.op === "list") {
        const account = await page.locator('a[href^="/account/"]').first().getAttribute('href');
        await route.fulfill({ json: { me: account?.split('/').pop(), friends: [], incoming: [], outgoing: [], challenges: [], badge: 0 } });
      } else await route.fulfill({ json: { code: "a-long-resettable-demo-add-me-link-1234567890" } });
    });
    const routes = process.env.ROUTES?.split(",") ?? ["/play", "/play/block-puzzle", "/play/holdem", "/play/trading-duel", "/play/vanguard", "/matches", "/friends", "/leaderboard", "/vault", "/vault#pro", "/backing", "/account/demo", "/help", "/docs"];
    let account;
    for (const route of routes) {
      const path = route === "/account/demo" ? account : route.split("#")[0];
      assert.ok(path, "demo Account key is available");
      await page.goto(`${base}${path}?dev=demo`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      if (route !== "/docs") {
        await page.locator(".acct-btn").waitFor({ timeout: 60000 });
        account = await page.locator('a[href^="/account/"]').first().getAttribute("href");
      }
      if (route.startsWith("/vault")) {
        const pro = page.getByRole("switch", { name: "Pro view" });
        await pro.waitFor();
        if ((await pro.getAttribute("aria-checked") === "true") !== route.endsWith("#pro")) await pro.click();
      }
      if (route === "/friends") {
        await page.locator(".fr-link-reset:not(:disabled)").waitFor({ timeout: 30000 });
        await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.copiedLink = text; } } }));
        await page.getByRole("button", { name: "Copy", exact: true }).click();
        assert.match(await page.evaluate(() => window.copiedLink), /\/friend\/a-long-resettable/);
        await page.getByRole("button", { name: "Reset link", exact: true }).click();
        await page.getByRole("dialog").waitFor();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        for (const control of [page.locator(".fr-link-row .btn"), page.locator(".fr-link-reset")]) {
          const box = await control.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width, "Friends controls fit and remain tappable");
        }
      }
      await page.waitForTimeout(1000);
      const result = await page.evaluate((width) => ({
        innerWidth, scrollWidth: document.documentElement.scrollWidth,
        overflowing: [...document.querySelectorAll("main *")].filter((el) => el.getBoundingClientRect().right > width + 1).slice(0, 12).map((el) => ({ tag: el.tagName, class: el.className, right: el.getBoundingClientRect().right })),
      }), width);
      results.push({ width, route, ...result });
      await writeFile(join(out, "overflow-results.json"), JSON.stringify(results, null, 2));
      console.log(`${result.scrollWidth > width || result.innerWidth !== width ? "FAIL" : "PASS"} ${width} ${route}: scroll=${result.scrollWidth}, inner=${result.innerWidth}`);
      if (result.scrollWidth > width) console.log(JSON.stringify(result.overflowing));
      if (width === 360 && route === "/friends") await page.screenshot({ path: join(out, "friends-360.png"), fullPage: true });
    }
    await page.close();
  }
  await writeFile(join(out, "overflow-results.json"), JSON.stringify(results, null, 2));
  assert.equal(results.filter((r) => r.scrollWidth > r.innerWidth || r.scrollWidth > r.width || r.innerWidth !== r.width).length, 0, "app routes must fit the viewport without mobile zoom-out");
} finally {
  await browser.close();
}
