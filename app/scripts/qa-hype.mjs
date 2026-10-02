/**
 * QA driver for HYPE / cross-chain journeys on devnet + HyperEVM testnet + Hoodi (dev wallets, NEXT_PUBLIC_DEV_WALLET=1).
 *
 *   PW=/path/to/playwright-core BASE=http://localhost:3152 node scripts/qa-hype.mjs <cmd> <dev> [args]
 *   open-hype <dev> <simHYPE> <months>   top-up drip, simHYPE faucet, open a HYPE Position, wait for the Advance
 *   open-eth  <dev> <simETH> <months>    same on Hoodi
 *   open-sol  <dev> <simSOL> <months>    simSOL faucet + native Position
 *   state <dev>                          screenshot of the Wallet and the visible figures
 *
 * Dev keys are kept in $QA_KEYS (testnet-only throwaway keys) so a Position stays reachable between runs.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58").default ?? require("bs58");
const { generatePrivateKey } = require("viem/accounts");
const BASE = process.env.BASE ?? "http://localhost:3152";
const OUT = process.env.OUT ?? `${process.cwd()}/docs/screens`;
const [cmd, dev, amount, months] = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const keyFile = process.env.QA_KEYS ?? `${process.env.HOME}/.cache/tesoro-tmp/e2e-hype/devkeys.json`;
const keys = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, "utf8")) : {};
if (!keys[dev]) {
  keys[dev] = { sol: bs58.encode(Keypair.generate().secretKey), evm: generatePrivateKey() };
  writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
}
export const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: Number(process.env.W ?? 390), height: Number(process.env.H ?? 844) } });
await ctx.addInitScript(([d, k]) => { localStorage.setItem(`tesoro-dev-wallet:${d}`, k.sol); localStorage.setItem(`tesoro-dev-evm:${d}`, k.evm); localStorage.setItem("tesoro-guide-dismissed", JSON.stringify(["account","backing","backing-first","gemas","lobby-first","matches","redeem","trouble","wallet-first","xc-open","wallet","lobby","play","help"])); }, [dev, keys[dev]]);
const p = await ctx.newPage();
const rpcCount = {};
p.on("response", async (r) => {
  const u = r.url();
  if (!/hyperliquid|hoodi|publicnode/.test(u) || r.request().method() !== "POST") return;
  rpcCount[u] = (rpcCount[u] ?? 0) + 1;
  const body = await r.text().catch(() => "");
  if (r.status() >= 400 || /"error"/.test(body)) log("RPC", r.status(), (r.request().postData() ?? "").slice(0, 120), "=>", body.slice(0, 200));
});
const shot = (n, full = true) => p.screenshot({ path: `${OUT}/qa-2026-10-02-hype-${n}.png`, fullPage: full }).catch(() => {});
const enabled = (name) => p.waitForFunction((n) => [...document.querySelectorAll("button")].some((b) => b.textContent?.startsWith(n) && !b.disabled), name, { timeout: 180000 });
const click = async (name) => { await enabled(name); await p.evaluate((n) => [...document.querySelectorAll("button")].filter((b) => b.textContent?.startsWith(n) && !b.disabled).pop().click(), name); };
const tab = { "open-hype": "HYPE", "open-eth": "ETH" }[cmd];
const unit = { "open-hype": "HYPE", "open-eth": "ETH" }[cmd];
try {
  await p.goto(`${BASE}/wallet?dev=${dev}`, { waitUntil: "load", timeout: 180000 });
  await p.waitForTimeout(2500);
  const gotIt = p.getByRole("button", { name: "Got it" });
  if (await gotIt.count()) await gotIt.click();
  if (cmd === "state") {
    await p.waitForTimeout(Number(process.env.WAIT ?? 8000));
    console.log(await p.locator("main").innerText());
    await shot(`state-${dev}`);
  } else if (cmd === "open-hype" || cmd === "open-eth") {
    await p.getByRole("button", { name: "Open a Position" }).first().click();
    await p.getByRole("tab", { name: tab }).click();
    const gasSel = `dt:has-text('(gas)') + dd`;
    const bal = async () => (await p.locator(gasSel).innerText().catch(() => "")).trim();
    for (let i = 0; i < 30 && !(await bal()).match(/\d/); i++) await p.waitForTimeout(1000);
    log("gas before", await bal());
    await shot(`${dev}-1-before-drip`);
    const topup = cmd === "open-hype" ? "Get test HYPE" : "Get test ETH";
    if (await p.getByRole("button", { name: topup }).count()) {
      const t0 = Date.now();
      await click(topup);
      await p.waitForFunction((n) => !document.body.innerText.includes(n), "Getting test", { timeout: 120000 });
      log("drip done in", Math.round((Date.now() - t0) / 1000), "s; gas", await bal());
      await shot(`${dev}-2-after-drip`);
    }
    if (!(await p.getByText("Faucet cooling down").count())) {
      const t0 = Date.now();
      await click(`Get test sim${unit}`);
      await p.waitForFunction(() => document.body.innerText.includes("Faucet cooling down"), null, { timeout: 180000 });
      log("simLST faucet in", Math.round((Date.now() - t0) / 1000), "s");
    }
    await p.locator("input[inputmode='decimal'], input[placeholder='0.0']").first().fill(amount);
    await p.locator("input[type=range]").first().fill(months);
    await p.waitForTimeout(1500);
    log("form", (await p.locator("dl.kv, .wl-faucet ~ dl").allInnerTexts()).join(" | ").replace(/\n/g, " ").slice(0, 300));
    await shot(`${dev}-3-form`);
    const t0 = Date.now();
    await click(`Open ${unit === "ETH" ? "an" : "a"} ${unit} Position`);
    log("open clicked", p.url());
    await p.waitForTimeout(3000);
    await shot(`${dev}-4-tracker-start`);
    if (process.env.LEAVE) {
      // Leave the tracker mid-flight for the Lobby, come back to /wallet/opening without ?op=, and check it resumed.
      await p.waitForURL(/wallet\/opening/, { timeout: 180000 });
      await p.waitForTimeout(20000);
      log("tracker before leaving:", (await p.locator("main").innerText()).split("\n").filter((l) => /confirmed|delivered|recorded|available|Delivering|Confirming|Recording|Waiting/i.test(l)).join(" | "));
      await shot(`${dev}-4b-before-leaving`);
      await p.goto(`${BASE}/?dev=${dev}`, { waitUntil: "load" });
      await p.waitForTimeout(25000);
      await shot(`${dev}-4c-lobby-while-away`);
      await p.goto(`${BASE}/wallet/opening?dev=${dev}`, { waitUntil: "load" });
      await p.waitForTimeout(6000);
      log("tracker after returning:", (await p.locator("main").innerText()).split("\n").filter((l) => /confirmed|delivered|recorded|available|Delivering|Confirming|Recording|Waiting|No ETH/i.test(l)).join(" | "), "| url", p.url());
      await shot(`${dev}-4d-after-returning`);
    }
    await p.getByText("Your Gemas are available.").waitFor({ timeout: 420000 });
    log("opened + Advance in", Math.round((Date.now() - t0) / 1000), "s; url", p.url());
    await shot(`${dev}-5-opened`);
  } else if (cmd === "open-sol") {
    await p.getByRole("button", { name: "Open a Position" }).first().click();
    await p.waitForTimeout(4000);
    if (!(await p.getByText("simSOL faucet ·").count())) { await click("Get test simSOL"); await p.getByText("simSOL faucet ·").waitFor({ timeout: 120000 }); }
    await p.locator("input[placeholder='0.0']").fill(amount);
    if (months) await p.locator("input[type=range]").first().fill(months).catch(() => {});
    for (let i = 0; i < 40 && !(await p.getByText("Position opened").count()); i++) {
      await p.evaluate(() => [...document.querySelectorAll("button")].filter((b) => /^Open a Position · /.test(b.textContent ?? "") && !b.disabled).pop()?.click());
      await p.waitForTimeout(4000);
    }
    await p.getByText("Position opened").waitFor({ timeout: 60000 });
    log("opened");
    await shot(`${dev}-sol-opened`);
  }
} catch (e) {
  log("FAILED", e.message.split("\n")[0], (e.stack.match(/qa-hype.mjs:\d+/) ?? [])[0]);
  await shot(`${dev}-failed`);
  process.exitCode = 1;
}
log("rpc posts", JSON.stringify(rpcCount));
await browser.close();
