/**
 * Live proof of a Backed Trading Duel on devnet with three dev wallets: C (no Gemas) posts a
 * Request for Trading Duel, A (Backer) answers with an Offer, C accepts and enters the Queue under
 * the Backing, B (opponent) joins from the Queue, both trade, the Match settles.
 *
 *   PW=... BASE=http://localhost:3161 node scripts/qa-trading-duel-backed.mjs
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
const ASSET = process.env.ASSET ?? "sol";
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
const pa = await mk(1440, 900, "tdA", keys.p0); // Backer
const pb = await mk(390, 844, "tdB", keys.p1); // opponent
const pc = await mk(1440, 900, "tdC", keys.p2); // backed Player
const shot = (p, name, full = false) => p.screenshot({ path: `${OUT}/trading-duel-live-backed${ASSET === "sol" ? "" : "-" + ASSET}-${name}.png`, fullPage: full });

// RESUME=1 skips straight to the Queue when the Backing was already accepted.
if (process.env.RESUME) {
  await pc.goto(`${BASE}/backing?dev=tdC`, { waitUntil: "load", timeout: 180000 });
  await pc.locator('article[aria-label="Accepted Backing"]').first().waitFor({ timeout: 180000 });
} else {
// C posts a Request.
await pc.goto(`${BASE}/backing?dev=tdC`, { waitUntil: "load", timeout: 180000 });
if (!process.env.SKIP_POST) {
  await pc.getByRole("button", { name: "Post a Request" }).first().click();
  await pc.locator("#req-game").selectOption("trading-duel");
  await pc.getByRole("button", { name: "Post Request" }).click();
  await pc.getByText(/Request posted/i).waitFor({ timeout: 120000 });
  log("C posted a Request");
}
await shot(pc, "c-request");

// A answers with an Offer.
await pa.goto(`${BASE}/backing?dev=tdA`, { waitUntil: "load", timeout: 180000 });
const card = pa.locator('section[aria-label="Requests"] article', { hasText: "Trading Duel" }).first();
for (let i = 0; i < 20 && !(await card.count()); i++) {
  await pa.waitForTimeout(6000);
  await pa.reload({ waitUntil: "load" });
}
await card.getByRole("button", { name: "Make an Offer" }).click();
await shot(pa, "a-offer-drawer");
await pa.locator('[role="dialog"][aria-label="Make an Offer"]').getByRole("button", { name: "Make an Offer" }).click();
await pa.getByText(/Offer (sent|posted|made)|Gemas reserved|reserved/i).first().waitFor({ timeout: 120000 }).catch(() => {});
log("A made an Offer");
await shot(pa, "a-offered");

// C accepts, then enters the Queue under the Backing.
await pc.reload({ waitUntil: "load" });
await pc.locator('article[aria-label="Offer for you"]').getByRole("button", { name: /Accept/ }).first().waitFor({ timeout: 180000 });
await pc.locator('article[aria-label="Offer for you"]').getByRole("button", { name: /Accept/ }).first().click();
await pc.locator('article[aria-label="Accepted Backing"]').first().waitFor({ timeout: 180000 });
log("C accepted");
}
await shot(pc, "c-accepted");
const accepted = pc.locator('article[aria-label="Accepted Backing"]').first();
if (ASSET !== "sol") await accepted.locator("label.asset", { hasText: ASSET.toUpperCase() }).click();
await accepted.getByRole("link", { name: /Enter the Queue/ }).click();
await pc.waitForURL(/\/play\/match\/\d+/, { timeout: 240000 });
const id = pc.url().match(/match\/(\d+)/)[1];
log("C in match", id);

// B joins from the Queue (SOL, the asset a backed Player queues on).
await pb.goto(`${BASE}/play/queue?game=trading-duel&asset=${ASSET}&entry=1000&dev=tdB`, { waitUntil: "load", timeout: 180000 });
await pb.waitForURL(/\/play\/match\/\d+/, { timeout: 240000 });
log("B in match", pb.url().match(/match\/(\d+)/)[1]);

await pc.waitForFunction(() => !document.querySelector(".td-btn.up")?.disabled && !!document.querySelector(".td-btn.up"), null, { timeout: 300000 });
await pc.locator(".td-btn.up").click();
await pb.waitForFunction(() => !document.querySelector(".td-btn.down")?.disabled && !!document.querySelector(".td-btn.down"), null, { timeout: 120000 });
await pb.locator(".td-btn.down").click();
log("both traded");
await shot(pc, "c-trading");

await pc.locator('[aria-label^="Match result"]').waitFor({ timeout: 720000 });
await pb.locator('[aria-label^="Match result"]').waitFor({ timeout: 180000 });
await pc.waitForTimeout(5000);
await shot(pc, "c-result", true);
await shot(pb, "b-result", true);
await pa.goto(`${BASE}/play/match/${id}?dev=tdA`, { waitUntil: "load" });
await pa.waitForTimeout(8000);
await shot(pa, "a-backer-view", true);
log("C text:", (await pc.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 700));
log("A text:", (await pa.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 700));
await browser.close();
