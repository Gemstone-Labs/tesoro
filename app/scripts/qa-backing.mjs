/**
 * Backing journey through the UI: Player posts a Request, Backer answers with an Offer, Player accepts, prints the
 * backed Challenge URL.   PLAYER=<dev> BACKER=<dev> ENTRY=500 SHARE=40 node scripts/qa-backing.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW);
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58").default ?? require("bs58");
const { PLAYER, BACKER, ENTRY = "500", SHARE = "40" } = process.env;
const BASE = process.env.BASE ?? "http://localhost:3152";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const keys = JSON.parse(readFileSync(`${process.env.HOME}/.cache/tesoro-tmp/e2e-hype/devkeys.json`, "utf8"));
const short = (k) => `${k.slice(0, 4)}...${k.slice(-4)}`;
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] });
const mk = async (dev, w) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
  await ctx.addInitScript(([d, k]) => { localStorage.setItem(`tesoro-dev-wallet:${d}`, k.sol); localStorage.setItem(`tesoro-dev-evm:${d}`, k.evm); localStorage.setItem("tesoro-guide-dismissed", JSON.stringify(["backing","backing-first","wallet-first","gemas","lobby-first","account","redeem"])); }, [dev, keys[dev]]);
  const p = await ctx.newPage(); p.setDefaultTimeout(150000); return p;
};
const shot = (p, n) => p.screenshot({ path: `${process.cwd()}/docs/screens/qa-2026-10-02-hype-backing-${n}.png`, fullPage: true }).catch(() => {});
const pp = await mk(PLAYER, 390);
const pbk = await mk(BACKER, 1440);
const { PublicKey } = require("@solana/web3.js");
const playerKey = PublicKey.findProgramAddressSync([Buffer.from("account"), Keypair.fromSecretKey(bs58.decode(keys[PLAYER].sol)).publicKey.toBuffer()], new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh"))[0].toBase58();
try {
  if (!process.env.SKIP_POST) {
  await pp.goto(`${BASE}/backing?dev=${PLAYER}`, { waitUntil: "load" });
  await pp.waitForTimeout(8000);
  await pp.getByRole("button", { name: "Post a Request" }).click();
  await pp.waitForTimeout(1500);
  await pp.locator("label.entry", { hasText: new RegExp(`^${ENTRY}$`) }).click();
  await shot(pp, "1-post-request");
  await pp.getByRole("button", { name: "Post Request" }).click();
  await pp.getByText("Request posted").waitFor();
  log("Request posted by", short(playerKey));
  await shot(pp, "2-request-posted");
  }
  if (process.env.SKIP_POST) await pp.goto(`${BASE}/backing?dev=${PLAYER}`, { waitUntil: "load" });
  // Backer: find the Request card and open the Offer drawer.
  await pbk.goto(`${BASE}/backing?dev=${BACKER}`, { waitUntil: "load" });
  const card = pbk.locator(`article:has-text("${playerKey.slice(0, 4)}")`).first();
  await card.waitFor({ timeout: 180000 }).catch(async () => { await pbk.reload({ waitUntil: "load" }); await card.waitFor(); });
  await shot(pbk, "3-backer-sees-request");
  await card.getByRole("button", { name: "Make an Offer" }).click();
  await pbk.waitForTimeout(1500);
  const slider = pbk.locator("aside[role=dialog] input[type=range]");
  await slider.fill(String(100 - Number(SHARE) === 0 ? 10 : SHARE));
  await shot(pbk, "4-offer-drawer");
  await pbk.locator("aside[role=dialog]").getByRole("button", { name: "Make an Offer" }).click();
  await pbk.getByText(/Offer (posted|sent)/i).first().waitFor();
  log("Offer sent by", BACKER);
  await shot(pbk, "5-offer-sent");
  // Player: accept.
  await pp.reload({ waitUntil: "load" });
  const acc = pp.getByRole("button", { name: "Accept", exact: true });
  await acc.waitFor({ timeout: 180000 }).catch(async () => { await pp.reload({ waitUntil: "load" }); await acc.waitFor(); });
  await shot(pp, "6-offer-for-you");
  await acc.click();
  await pp.getByText("Offer accepted").waitFor();
  log("Offer accepted");
  await pp.waitForTimeout(6000);
  await shot(pp, "7-accepted");
  const href = await pp.locator("a[href*='/play/challenge?'][href*='backing=']").first().getAttribute("href").catch(() => null);
  log("backed challenge href", href);
} catch (e) {
  log("FAILED", e.message.split("\n")[0]);
  await shot(pp, "failed-player"); await shot(pbk, "failed-backer");
  process.exitCode = 1;
}
await browser.close();
