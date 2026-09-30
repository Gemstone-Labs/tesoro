/**
 * Screenshots of the p2b screens at 1920x1200 and 390x844 into docs/screens/p2b-*.png, then the
 * side-by-side comparisons p2b-compare-*.png (mockup left, build right).
 * Needs a dev server with NEXT_PUBLIC_DEV_WALLET=1 and playwright-core:
 *
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3120 node scripts/screenshot-p2b.mjs [name,name]
 *
 * Fixtures: ?dev=demo (populated fake Account), /design/result, /design/play, /design/table.
 * The cross-chain page seeds one in-flight `open` operation into the dev wallet's localStorage.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58").default ?? require("bs58");
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../docs/screens");
const ART = process.env.ART ?? resolve(homedir(), "Work/gemstone-labs/tesoro/art-source/ui-redesign");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE ?? "http://localhost:3120";

/** Place pieces by tap (piece, then a board cell) until something fits, a few times: fills the board and clears a line or two. */
async function playSome(page) {
  await page.waitForSelector(".bp-slot:not(:disabled)", { timeout: 20000 });
  for (let n = 0; n < 12; n++) {
    const slots = await page.$$(".bp-slot:not(:disabled):not(.used)");
    if (!slots.length) break;
    let placed = false;
    for (const s of slots) {
      await s.click();
      for (const cell of [0, 8, 16, 24, 32, 40, 48, 56, 4, 12, 20, 28, 36, 44, 52, 60]) {
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
  { name: "lobby", route: "/?dev=demo", wait: 5000 },
  { name: "wallet", route: "/wallet?dev=demo", wait: 5000 },
  { name: "backing", route: "/backing?dev=demo", wait: 5000 },
  { name: "backing-offer", route: "/backing?dev=demo", wait: 5000, act: (p) => p.getByRole("button", { name: "Make an Offer" }).first().click() },
  { name: "result-won-overlay", route: "/design/result?case=won&dev=demo", waitFor: ".mo", wait: 700 },
  { name: "result-won", route: "/design/result?case=won&dev=demo", waitFor: ".mo", wait: 4000 },
  { name: "result-lost", route: "/design/result?case=lost&dev=demo", wait: 4600 },
  { name: "result-backer-won-overlay", route: "/design/result?case=backer-won&dev=demo", waitFor: ".mo", wait: 700 },
  { name: "game-block-puzzle", route: "/play/block-puzzle?dev=demo", wait: 5000 },
  { name: "game-holdem", route: "/play/holdem?dev=demo", wait: 5000 },
  { name: "play-block-puzzle", route: "/design/play?dev=demo", wait: 2500, act: playSome },
  { name: "play-holdem", route: "/design/table?dev=demo", wait: 3000 },
  { name: "play-holdem-facing", route: "/design/table?dev=demo&facing=1", wait: 3000 },
  { name: "wallet-crosschain", route: "/wallet?dev=shot", wait: 3500, seedOp: true },
];
const sizes = [
  [1920, 1200, "1920"],
  [390, 844, "390"],
];
const only = process.argv[2]?.split(",");

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
for (const s of shots) {
  if (only && !only.includes(s.name)) continue;
  for (const [w, h, tag] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${s.route}`, { waitUntil: "load", timeout: 180000 });
    if (s.seedOp) {
      await page.waitForFunction(() => localStorage.getItem("tesoro-dev-wallet:shot"), null, { timeout: 60000 });
      const secret = await page.evaluate(() => localStorage.getItem("tesoro-dev-wallet:shot"));
      const address = Keypair.fromSecretKey(bs58.decode(secret)).publicKey.toBase58();
      const op = { key: "open-shot-1", kind: "open", vault: "0x6c836b96dbb0c6cdbfe2bd5d9c1ba8b8a2c3e4bD", id: "1", months: 1, hash: "0x37ab000000000000000000000000000000000000000000000000000000000000", createdAt: Date.now() };
      await page.evaluate(([a, o]) => localStorage.setItem(`tesoro-eth-ops:${a}`, JSON.stringify([o])), [address, op]);
      await page.goto(`${BASE}/wallet/opening?op=open-shot-1&dev=shot`, { waitUntil: "load", timeout: 180000 });
    }
    if (s.waitFor) await page.waitForSelector(s.waitFor, { timeout: 60000 }).catch(() => console.log("no", s.waitFor, s.name));
    await page.waitForTimeout(s.wait ?? 4500);
    if (s.act) {
      await s.act(page).catch((e) => console.log("act failed", s.name, e.message.split("\n")[0]));
      await page.waitForTimeout(800);
    }
    await page.evaluate(() => document.fonts.ready);
    const file = `${OUT}/p2b-${s.name}-${tag}.png`;
    await page.screenshot({ path: file, fullPage: w < 1000 });
    console.log("wrote", file);
    await ctx.close();
  }
}
await browser.close();

const pairs = [
  ["play-block-puzzle", "play-block-puzzle-desktop", "play-block-puzzle"],
  ["play-holdem", "play-holdem-desktop", "play-holdem"],
  ["wallet-crosschain", "wallet-crosschain-desktop", "wallet-crosschain"],
  ["game-block-puzzle", "game-block-puzzle-desktop", "game-block-puzzle"],
  ["result-won", "result-won-desktop", "result-won-overlay"],
  ["wallet", "wallet-desktop", "wallet"],
  ["backing", "backing-desktop", "backing-offer"],
  ["lobby", "lobby-desktop", "lobby"],
];
for (const [name, dir, shot] of pairs) {
  if (only && !only.includes(shot)) continue;
  await sharp({ create: { width: 3860, height: 1200, channels: 3, background: "#ffffff" } })
    .composite([
      { input: resolve(ART, dir, "take-1.png"), left: 0, top: 0 },
      { input: resolve(OUT, `p2b-${shot}-1920.png`), left: 1940, top: 0 },
    ])
    .png()
    .toFile(resolve(OUT, `p2b-compare-${name}.png`));
  console.log("wrote compare", name);
}
