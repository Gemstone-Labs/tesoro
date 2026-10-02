/**
 * Live proof on Solana devnet with two dev wallets (NEXT_PUBLIC_DEV_WALLET=1): a Trading Duel Match
 * from the Queue to the settled result, Player A on desktop and Player B on a phone viewport.
 * Wallet keys are the funded test wallets of programs/trading_duel/scripts/play.ts (~/.cache/tmp/td-keys.json).
 *
 *   PW=/path/to/playwright-core BASE=http://localhost:3161 node scripts/qa-trading-duel.mjs [full|draw] [sol|eth|hype]
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
const BASE = process.env.BASE ?? "http://localhost:3161";
const MODE = process.argv[2] ?? "full";
const ASSET = process.argv[3] ?? "sol";
const ENTRY = process.env.ENTRY ?? "500";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const keys = JSON.parse(readFileSync(`${process.env.HOME}/.cache/tmp/td-keys.json`, "utf8"));
const secret = (k) => bs58.encode(Uint8Array.from(k));

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const mk = async (w, h, dev, key) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(([d, k]) => {
    localStorage.setItem(`tesoro-dev-wallet:${d}`, k);
    localStorage.setItem("tesoro-guide-dismissed", JSON.stringify(["account", "backing", "backing-first", "gemas", "lobby-first", "matches", "redeem", "trouble", "wallet-first", "xc-open", "play-first", "game-first", "match-first"]));
  }, [dev, secret(key)]);
  const p = await ctx.newPage();
  p.setDefaultTimeout(120000);
  p.on("pageerror", (e) => log(dev, "pageerror", String(e).slice(0, 200)));
  return p;
};
const pa = await mk(1440, 900, "tdA", keys.p0);
const pb = await mk(390, 844, "tdB", keys.p1);
const shot = (p, name, full = false) => p.screenshot({ path: `${OUT}/trading-duel-live-${MODE}-${name}.png`, fullPage: full });

async function enter(p, dev) {
  await p.goto(`${BASE}/play/queue?game=trading-duel&asset=${ASSET}&entry=${ENTRY}&dev=${dev}`, { waitUntil: "load", timeout: 180000 });
  await p.waitForURL(/\/play\/match\/\d+/, { timeout: 240000 });
  return p.url().match(/match\/(\d+)/)[1];
}

const idA = await enter(pa, "tdA");
log("A in match", idA);
const idB = await enter(pb, "tdB");
log("B in match", idB);
if (idA !== idB) throw new Error("not paired");
await shot(pa, "a-setup");

// Wait for trading to open.
const upA = pa.locator(".td-btn.up");
await upA.waitFor({ timeout: 300000 });
await pa.waitForFunction(() => !document.querySelector(".td-btn.up")?.disabled, null, { timeout: 120000 });
log("trading open");
await shot(pa, "a-open");
await shot(pb, "b-open");

if (MODE === "full") {
  await pa.locator(".td-presets button", { hasText: "25%" }).first().click().catch(() => {});
  await upA.click();
  log("A long");
  await pb.waitForFunction(() => !document.querySelector(".td-btn.down")?.disabled, null, { timeout: 120000 });
  await pb.locator(".td-btn.down").click();
  log("B short");
  await pa.waitForTimeout(12000);
  await shot(pa, "a-position");
  await shot(pb, "b-position");
  await pa.getByRole("button", { name: "Close" }).click().catch((e) => log("close", String(e).slice(0, 100)));
  log("A closed");
  await pa.waitForTimeout(4000);
  await shot(pa, "a-closed");
  await pa.getByRole("button", { name: /Flip to/ }).count();
}

// Wait for the end and the settled result card on both (the clients end, commit and settle the Match themselves).
await pa.locator('[aria-label^="Match result"]').waitFor({ timeout: 720000 });
await pb.locator('[aria-label^="Match result"]').waitFor({ timeout: 120000 });
await pa.waitForTimeout(6000);
await shot(pa, "a-result", true);
await shot(pb, "b-result", true);
log("A text:", (await pa.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 600));
await browser.close();
