/**
 * Declutter screenshots: full page at 1920x1200 and 390x844, signed out and signed in (dev wallet fixtures).
 *   PW=/path/to/playwright-core BASE=http://localhost:3200 node scripts/screenshot-declutter.mjs before|after [name,name]
 * Writes docs/screens/declutter-<name>-<out|in>-<1920|390>-<tag>.png (needs NEXT_PUBLIC_DEV_WALLET=1).
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
const BASE = process.env.BASE ?? "http://localhost:3200";
const tag = process.argv[2] ?? "after";
const only = process.argv[3]?.split(",");

async function playSome(page) {
  await page.waitForSelector(".bp-slot:not(:disabled)", { timeout: 20000 });
  for (let n = 0; n < 6; n++) {
    const slots = await page.$$(".bp-slot:not(:disabled):not(.used)");
    let placed = false;
    for (const s of slots) {
      await s.click();
      for (const cell of [0, 8, 16, 24, 32, 40, 48, 56]) {
        const before = await page.locator(".bp-cell.on").count();
        await page.locator(".bp-board .bp-cell").nth(cell).click({ force: true });
        if ((await page.locator(".bp-cell.on").count()) !== before) {
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) break;
  }
}
const shots = [
  { name: "lobby", route: "/", signedOut: true },
  { name: "game-block-puzzle", route: "/play/block-puzzle", signedOut: true },
  { name: "game-holdem", route: "/play/holdem", signedOut: true },
  { name: "play-block-puzzle", route: "/design/play", act: playSome },
  { name: "play-holdem", route: "/design/table" },
  { name: "wallet", route: "/wallet", signedOut: true },
  { name: "backing", route: "/backing", signedOut: true },
  { name: "result-won", route: "/design/result?case=won", wait: 4500 },
  { name: "result-lost", route: "/design/result?case=lost", wait: 4500 },
  { name: "wallet-crosschain", route: "/wallet?dev=shot", seedOp: true, inOnly: true },
];
const sizes = [
  [1920, 1200, "1920"],
  [390, 844, "390"],
];
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
for (const s of shots) {
  if (only && !only.includes(s.name)) continue;
  for (const mode of ["out", "in"]) {
    if (mode === "out" && !s.signedOut) continue;
    for (const [w, h, sz] of sizes) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      const dev = mode === "out" ? "out" : "demo";
      const route = s.route.includes("dev=") ? s.route : s.route + (s.route.includes("?") ? "&" : "?") + `dev=${dev}`;
      await page.goto(BASE + route, { waitUntil: "load", timeout: 180000 });
      if (s.seedOp) {
        const { Keypair } = require("@solana/web3.js");
        const bs58 = require("bs58").default ?? require("bs58");
        await page.waitForFunction(() => localStorage.getItem("tesoro-dev-wallet:shot"), null, { timeout: 60000 });
        const secret = await page.evaluate(() => localStorage.getItem("tesoro-dev-wallet:shot"));
        const address = Keypair.fromSecretKey(bs58.decode(secret)).publicKey.toBase58();
        const op = { key: "open-shot-1", kind: "open", vault: "0x6c836b96dbb0c6cdbfe2bd5d9c1ba8b8a2c3e4bD", id: "1", months: 1, hash: "0x37ab000000000000000000000000000000000000000000000000000000000000", createdAt: Date.now() };
        await page.evaluate(([a, o]) => localStorage.setItem(`tesoro-eth-ops:${a}`, JSON.stringify([o])), [address, op]);
        await page.goto(`${BASE}/wallet/opening?op=open-shot-1&dev=shot`, { waitUntil: "load", timeout: 180000 });
      }
      await page.waitForTimeout(s.wait ?? 5000);
      if (s.act) {
        await s.act(page).catch((e) => console.log("act failed", e.message.split("\n")[0]));
        await page.waitForTimeout(800);
      }
      await page.evaluate(() => document.fonts.ready);
      const file = `${OUT}/declutter-${s.name}-${mode}-${sz}-${tag}.png`;
      await page.screenshot({ path: file, fullPage: true });
      console.log("wrote", file);
      await ctx.close();
    }
  }
}
await browser.close();
