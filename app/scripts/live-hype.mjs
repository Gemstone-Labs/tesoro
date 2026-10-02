/**
 * Live HYPE helpers on devnet + HyperEVM testnet with dev wallets (NEXT_PUBLIC_DEV_WALLET=1).
 *
 *   PW=/path/to/playwright-core BASE=http://localhost:3108 node scripts/live-hype.mjs open <dev> <simHYPE> <months>
 *   ... fund-sol <dev> <simSOL>
 *
 * `open`: Get test HYPE (server drip), Get test simHYPE, open a HYPE Position, wait for the Advance.
 * `fund-sol`: simSOL faucet + native Position (a Gema holder to play against).
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58").default ?? require("bs58");
const { generatePrivateKey } = require("viem/accounts");
const BASE = process.env.BASE ?? "http://localhost:3108";
const [cmd, dev, amount, months] = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
// Dev keys live in the browser's localStorage, so a fresh context is a fresh wallet. Keep ours in a local file
// (testnet-only throwaway keys) and seed them, so a run can be repeated and a Position stays reachable.
const keyFile = `${process.env.HOME}/.cache/tesoro-tmp/devkeys.json`;
const keys = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, "utf8")) : {};
if (!keys[dev]) {
  keys[dev] = { sol: bs58.encode(Keypair.generate().secretKey), evm: generatePrivateKey() };
  writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
}
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addInitScript(([d, k]) => { localStorage.setItem(`tesoro-dev-wallet:${d}`, k.sol); localStorage.setItem(`tesoro-dev-evm:${d}`, k.evm); }, [dev, keys[dev]]);
const p = await ctx.newPage();
const enabled = (name) => p.waitForFunction((n) => [...document.querySelectorAll("button")].some((b) => b.textContent?.startsWith(n) && !b.disabled), name, { timeout: 180000 });
const click = async (name) => { await enabled(name); await p.evaluate((n) => [...document.querySelectorAll("button")].filter((b) => b.textContent?.startsWith(n) && !b.disabled).pop().click(), name); };
try {
  await p.goto(`${BASE}/wallet?dev=${dev}`, { waitUntil: "load", timeout: 180000 });
  await p.getByRole("button", { name: "Open a Position" }).first().click();
  if (cmd === "open") {
    await p.getByRole("tab", { name: "HYPE" }).click();
    const bal = async () => (await p.locator("dt:has-text('(gas)') + dd").innerText().catch(() => "")).trim();
    for (let i = 0; i < 20 && !(await bal()).match(/\d/); i++) await p.waitForTimeout(1000);
    if (await p.getByRole("button", { name: "Get test HYPE" }).count()) { log("top-up"); await click("Get test HYPE"); await p.waitForFunction(() => !document.body.innerText.includes("Getting test HYPE"), null, { timeout: 120000 }); }
    log("gas", await bal());
    if (!(await p.getByText("Faucet cooling down").count())) { await click("Get test simHYPE"); await p.waitForFunction(() => document.body.innerText.includes("Faucet cooling down"), null, { timeout: 180000 }); }
    await p.locator("input[inputmode='decimal'], input[placeholder='0.0']").first().fill(amount);
    await p.locator("input[type=range]").first().fill(months);
    await p.waitForTimeout(1500);
    log("form", (await p.locator("dl.kv, .wl-faucet ~ dl").allInnerTexts()).join(" | ").replace(/\n/g, " ").slice(0, 200));
    await click("Open a HYPE Position");
    await p.getByText("Your Gemas are available.").waitFor({ timeout: 300000 });
    log("opened; Gemas", await p.locator("a[aria-label*='Your Gemas']").innerText().catch(() => "?"));
  } else {
    await p.waitForTimeout(4000);
    if (!(await p.getByText("simSOL faucet ·").count())) {
      await click("Get test simSOL");
      await p.getByText("simSOL faucet ·").waitFor({ timeout: 120000 });
    }
    await p.locator("input[placeholder='0.0']").fill(amount);
    for (let i = 0; i < 40 && !(await p.getByText("Position opened").count()); i++) {
      await p.evaluate(() => [...document.querySelectorAll("button")].filter((b) => /^Open a Position · /.test(b.textContent ?? "") && !b.disabled).pop()?.click());
      await p.waitForTimeout(4000);
    }
    await p.getByText("Position opened").waitFor({ timeout: 60000 });
    log("opened");
  }
} catch (e) {
  log("FAILED", e.message.split("\n")[0], (e.stack.match(/live-hype.mjs:\d+/) ?? [])[0]);
  await p.screenshot({ path: `/home/ailton/.cache/tesoro-tmp/live-hype-failed.png` });
  process.exitCode = 1;
}
await browser.close();
