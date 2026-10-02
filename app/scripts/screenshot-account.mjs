/**
 * A Player's Account (/account/<key>) screenshots, on dev fixtures and one real devnet read.
 *   PW=/path/to/playwright-core BASE=http://localhost:3217 node scripts/screenshot-account.mjs [name,name]
 * Writes docs/screens/account-<name>-<1920|390>.png (needs NEXT_PUBLIC_DEV_WALLET=1).
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const { PublicKey } = require("@solana/web3.js");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
const BASE = process.env.BASE ?? "http://localhost:3217";
const only = process.argv[2]?.split(",");

// The fixture's keys (lib/chain/fixture.ts `key(seed)`).
const demo = (seed) => PublicKey.findProgramAddressSync([Buffer.from(`demo-${seed}`)], PublicKey.default)[0].toBase58();
// A devnet Account with a backed win, a refund and a backed loss (docs/games/backing.md).
const DEVNET = "DA9Kg6dR6vyTXk56iZFjc4Dc6s6xgEhkh7vDi6JhP1bS";

const shots = [
  // A Player with a live Request: figures, running total, Back and Challenge, history with Backings.
  { name: "player", route: `/account/${demo(701)}?dev=demo` },
  { name: "player-holdem", route: `/account/${demo(701)}?game=holdem&dev=demo`, sizes: ["390"] },
  // The history as it is read: opponents link to their Accounts, backed rows carry the Backer's result.
  { name: "history", route: `/account/${demo(701)}?dev=demo`, scrollTo: ".mh-pages", viewportOnly: true },
  // A Player who is not asking to be backed.
  { name: "player-no-request", route: `/account/${demo(750)}?dev=demo`, sizes: ["1920"] },
  // The running total read with the pointer.
  { name: "chart-hover", route: `/account/${demo(701)}?dev=demo`, hover: ".pa-area", clip: ".pa-chart" },
  // The Challenge sheet: Game, entry, and that the link is the only delivery.
  { name: "challenge", route: `/account/${demo(701)}?dev=demo`, click: "#pa-challenge ~ button", viewportOnly: true },
  // The signed-in Account looking at itself, an Account that has not played, and addresses with no Account.
  { name: "own", route: `/account/${demo(1)}?dev=demo`, sizes: ["1920"], viewportOnly: true },
  { name: "new", route: `/account/${demo(998)}?dev=demo`, sizes: ["1920"], viewportOnly: true },
  { name: "none", route: `/account/${demo(999)}?dev=demo`, sizes: ["1920"], viewportOnly: true },
  { name: "invalid", route: "/account/not-a-key?dev=demo", sizes: ["1920"], viewportOnly: true },
  // Signed out, read from Solana devnet.
  { name: "devnet", route: `/account/${DEVNET}?dev=out`, sizes: ["1920"], wait: 12000 },
];
const SIZES = { 1920: [1920, 1200], 390: [390, 844] };

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
for (const s of shots) {
  if (only && !only.includes(s.name)) continue;
  for (const sz of s.sizes ?? ["1920", "390"]) {
    const [w, h] = SIZES[sz];
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await page.goto(BASE + s.route, { waitUntil: "load", timeout: 180000 });
    await page.waitForTimeout(s.wait ?? 5000);
    if (s.click) {
      await page.locator(s.click).click();
      await page.waitForTimeout(500);
    }
    if (s.hover) {
      const box = await page.locator(s.hover).boundingBox();
      await page.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2);
      await page.waitForTimeout(200);
    }
    if (s.scrollTo) {
      await page.locator(s.scrollTo).scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => document.fonts.ready);
    const file = `${OUT}/account-${s.name}-${sz}.png`;
    if (s.clip) await page.locator(s.clip).screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: !s.viewportOnly });
    console.log(file);
    await ctx.close();
  }
}
await browser.close();
