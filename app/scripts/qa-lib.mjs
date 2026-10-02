/** Shared helpers for the live QA drivers (dev wallets on `NEXT_PUBLIC_DEV_WALLET=1 next dev`). Testnet throwaway keys only. */
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
export const { chromium } = require(process.env.PW ?? "playwright-core");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58").default ?? require("bs58");
const { generatePrivateKey } = require("viem/accounts");
export const BASE = process.env.BASE ?? "http://localhost:3151";
export const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const keyFile = `${process.env.HOME}/.cache/tesoro-tmp/qa/devkeys.json`;
export function keysFor(dev) {
  const keys = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, "utf8")) : {};
  if (!keys[dev]) {
    keys[dev] = { sol: bs58.encode(Keypair.generate().secretKey), evm: generatePrivateKey() };
    writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
  }
  return keys[dev];
}
export async function launch() {
  return chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
}
export async function page(browser, dev, w = 1440, h = 900) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const k = keysFor(dev);
  await ctx.addInitScript(([d, k]) => { localStorage.setItem(`tesoro-dev-wallet:${d}`, k.sol); localStorage.setItem(`tesoro-dev-evm:${d}`, k.evm); }, [dev, k]);
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(String(e).slice(0, 200)));
  p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") p.errors.push(`${m.type()}: ${m.text().slice(0, 220)}`); });
  p.dev = dev;
  return p;
}
export const shot = (p, name, full = false) => p.screenshot({ path: `${OUT}/qa-2026-10-02-${name}.png`, fullPage: full });
export const enabled = (p, name, timeout = 180000) => p.waitForFunction((n) => [...document.querySelectorAll("button")].some((b) => b.textContent?.trim().startsWith(n) && !b.disabled), name, { timeout });
export const click = async (p, name, timeout) => { await enabled(p, name, timeout); await p.evaluate((n) => [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim().startsWith(n) && !b.disabled).pop().click(), name); };
export const body = (p) => p.evaluate(() => document.body.innerText);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const web3 = require("@solana/web3.js");
export const solAddr = (dev) => web3.Keypair.fromSecretKey(bs58.decode(keysFor(dev).sol)).publicKey.toBase58();
export const evmAddr = (dev) => require("viem/accounts").privateKeyToAccount(keysFor(dev).evm).address;
const RPC = process.env.QA_RPC ?? "https://api.devnet.solana.com";
/** Recent signatures touching an address (newest first), shortened. */
export async function sigs(addr, limit = 10) {
  const c = new web3.Connection(RPC, "confirmed");
  const r = await c.getSignaturesForAddress(new web3.PublicKey(addr), { limit });
  return r.map((s) => `${s.signature}${s.err ? " FAIL" : ""} ${new Date((s.blockTime ?? 0) * 1000).toISOString().slice(11, 19)}`);
}
/** Dismiss the Guide overlay (it blocks clicks) if it is up. */
export async function dismiss(p) {
  for (let i = 0; i < 3; i++) {
    const g = p.getByRole("button", { name: "Got it" });
    if (await g.count()) await g.first().click({ timeout: 3000 }).catch(() => {}); else break;
    await p.waitForTimeout(500);
  }
}
