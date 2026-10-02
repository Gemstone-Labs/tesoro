/**
 * Live proof on Solana devnet with two dev wallets (NEXT_PUBLIC_DEV_WALLET=1): fund each through the
 * native Position flow, play one real Block Puzzle Match and one real Hold'em hand to the result.
 * Player A is a 1920x1200 browser, player B a 390x844 one; screens go to docs/screens/p2b-live-*.png.
 *
 *   PW=/path/to/playwright-core BASE=http://localhost:3120 node scripts/live-p2b.mjs [funding|bp|holdem]
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
const BASE = process.env.BASE ?? "http://localhost:3120";
const A = process.env.A;
const B = process.env.B;
const TAG = process.env.TAG ?? "match";
const only = process.argv[2]?.split(",");
const ENTRY = process.env.ENTRY ?? "500";
const want = (s) => !only || only.includes(s);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const keys = JSON.parse(readFileSync(`${process.env.HOME}/.cache/tesoro-tmp/e2e-hype/devkeys.json`, "utf8"));
const mk = async (w, h, dev) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(([d, k]) => { localStorage.setItem(`tesoro-dev-wallet:${d}`, k.sol); localStorage.setItem(`tesoro-dev-evm:${d}`, k.evm); localStorage.setItem("tesoro-guide-dismissed", JSON.stringify(["account","backing","backing-first","gemas","lobby-first","matches","redeem","trouble","wallet-first","xc-open"])); }, [dev, keys[dev]]);
  const p = await ctx.newPage();
  p.setDefaultTimeout(90000);
  return p;
};
const settle = (p) => p.waitForTimeout(6000);
const pa = await mk(1440, 900, A);
const pb = await mk(390, 844, B);
const shot = async (p, name, full = false) => p.screenshot({ path: `${OUT}/qa-2026-10-02-hype-${TAG}-${name}.png`, fullPage: full });

async function fund(p, dev) {
  await p.goto(`${BASE}/wallet?dev=${dev}`, { waitUntil: "load", timeout: 180000 });
  const faucet = p.getByRole("button", { name: "Get test simSOL" });
  await faucet.waitFor({ timeout: 120000 });
  await p.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Get test simSOL" && !b.disabled), null, { timeout: 120000 });
  const gemas = () => p.locator(".wl-total-fig b").innerText().catch(() => "0");
  if ((await gemas()).replace(/,/g, "") !== "0" && (await gemas()) !== "0") {
    log(dev, "already funded", await gemas());
    return;
  }
  await faucet.click();
  await p.getByText("simSOL faucet ·").waitFor({ timeout: 120000 });
  await p.locator("input[placeholder='0.0']").fill("5");
  const open = p.getByRole("button", { name: /^Open a Position/ });
  await p.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => /^Open a Position/.test(b.textContent ?? "") && !b.disabled), null, { timeout: 120000 });
  await open.click();
  await p.getByText("Position opened").waitFor({ timeout: 120000 });
  log(dev, "position opened");
}

/** Tap pieces onto free cells until the run ends or `ms` pass. */
async function playBlocks(p, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await p.locator(".bp-board.live").count())) break;
    const slots = await p.$$(".bp-slot:not(:disabled):not(.used)");
    let placed = false;
    for (const s of slots) {
      await s.click().catch(() => {});
      for (let cell = 0; cell < 64 && !placed; cell += 3) {
        const before = await p.locator(".bp-cell.on").count();
        await p.locator(".bp-board .bp-cell").nth(cell).click({ force: true, timeout: 2000 }).catch(() => {});
        if ((await p.locator(".bp-cell.on").count()) !== before) placed = true;
      }
      if (placed) break;
    }
    await p.waitForTimeout(placed ? 250 : 1000);
  }
}

const link = async (p) => (await p.locator("body").innerText()).match(/\/play\/challenge\/\d+/)?.[0] ?? (await p.locator("a[href*='/play/challenge/'], input[value*='/play/challenge/']").first().evaluate((e) => e.getAttribute("href") ?? e.value).catch(() => null));

async function bpChallenge() {
  let id;
  let l = process.env.LINK;
  if (l) {
    id = l.split("/").pop();
    await pa.goto(`${BASE}/play/match/${id}?dev=${A}`, { waitUntil: "load", timeout: 180000 });
  } else {
  log("Block Puzzle Challenge: A creates it at entry", ENTRY);
  await pa.goto(process.env.CH_URL ? `${BASE}${process.env.CH_URL}&dev=${A}` : `${BASE}/play/challenge?entry=${ENTRY}&dev=${A}`, { waitUntil: "load", timeout: 180000 });
  await pa.waitForURL(/\/play\/match\//, { timeout: 180000 });
  id = pa.url().split("/").pop().split("?")[0];
  log("match", id);
  const start = pa.getByRole("button", { name: /Start run/ });
  await start.waitFor({ timeout: 180000 });
  await start.click();
  await pa.locator(".bp-board.live").waitFor({ timeout: 60000 });
  await playBlocks(pa, 70000);
  for (let i = 0; i < 30 && !l; i++) { l = await link(pa); if (!l) await pa.waitForTimeout(3000); }
  log("challenge link", l);
  await shot(pa, "challenge-link");
  }
  await pb.goto(`${BASE}${l.startsWith("http") ? new URL(l).pathname : l}?dev=${B}`, { waitUntil: "load", timeout: 180000 });
  const startB = pb.getByRole("button", { name: /Start run|Accept|Join/ });
  await startB.first().waitFor({ timeout: 180000 });
  await shot(pb, "challenge-join-390");
  await startB.first().click();
  const startB2 = pb.getByRole("button", { name: /Start run/ });
  if (await startB2.count()) await startB2.click().catch(() => {});
  await pb.locator(".bp-board.live").waitFor({ timeout: 90000 }).catch(() => {});
  await playBlocks(pb, Number(process.env.B_PLAY_MS ?? 4000));
  await pb.waitForTimeout(Number(process.env.B_IDLE_MS ?? 90000));
  await settleLoop(id);
}

async function settleLoop(id) {
  const deadline = Date.now() + 300000;
  let a = false;
  let b = false;
  while (Date.now() < deadline && !(a && b)) {
    for (const [p, set] of [[pa, () => (a = true)], [pb, () => (b = true)]]) {
      if (await p.getByRole("heading", { name: "Match result" }).count()) set();
      else {
        const sb = p.getByRole("button", { name: "Settle Match" });
        if (await sb.count()) await sb.click().catch(() => {});
      }
    }
    await pa.waitForTimeout(4000);
  }
  log("result A", a, "B", b);
  await pa.waitForTimeout(800);
  await shot(pa, "result-overlay-A");
  await shot(pb, "result-overlay-B");
  await pa.waitForTimeout(4000);
  await shot(pa, "result-A");
  await shot(pb, "result-B", true);
  for (const [n, p] of [["A", pa], ["B", pb]]) log(n, "result text:", (await p.locator("main").innerText()).split("\n").filter(Boolean).join(" | ").slice(0, 1100));
  log("Match", id, "done");
}

async function bpMatch() {
  log("Block Puzzle: A enters the queue");
  await pa.goto(`${BASE}/play/block-puzzle?dev=${A}`, { waitUntil: "load", timeout: 180000 });
  await settle(pa);
  await pa.locator("label.entry", { hasText: new RegExp(`^${ENTRY}$`) }).click().catch(() => {});
  await pa.getByRole("button", { name: "Play now" }).click();
  await pa.waitForURL(/\/play\/match\//, { timeout: 180000 });
  const id = pa.url().split("/").pop();
  log("match", id);
  const start = pa.getByRole("button", { name: /Start run/ });
  await start.waitFor({ timeout: 180000 });
  await shot(pa, "bp-ready");
  log("B joins the same Match");
  await pb.goto(`${BASE}/play/block-puzzle?dev=${B}`, { waitUntil: "load", timeout: 180000 });
  await settle(pb);
  await pb.locator("label.entry", { hasText: new RegExp(`^${ENTRY}$`) }).click().catch(() => {});
  await pb.getByRole("button", { name: "Play now" }).click();
  await pb.waitForURL(/\/play\/match\//, { timeout: 180000 });
  const startB = pb.getByRole("button", { name: /Start run/ });
  await startB.waitFor({ timeout: 180000 });
  await Promise.all([start.click(), startB.click()]);
  await pa.locator(".bp-board.live").waitFor({ timeout: 60000 });
  await pb.locator(".bp-board.live").waitFor({ timeout: 60000 });
  log("both running");
  await Promise.all([playBlocks(pa, 7000), playBlocks(pb, 4000)]);
  await shot(pa, "bp-play-1920");
  await shot(pb, "bp-play-390", true);
  // A keeps playing (a clearly higher score); B lets the clock run out.
  await playBlocks(pa, 60000);
  await pb.waitForTimeout(30000);
  log("runs over, waiting for the result");
  for (const p of [pa, pb]) {
    const settle = p.getByRole("button", { name: "Settle Match" });
    await settle.waitFor({ timeout: 60000 }).catch(() => {});
  }
  const deadline = Date.now() + 180000;
  let a = false;
  let b = false;
  while (Date.now() < deadline && !(a && b)) {
    for (const [p, set] of [[pa, () => (a = true)], [pb, () => (b = true)]]) {
      if (await p.getByRole("heading", { name: "Match result" }).count()) set();
      else {
        const s = p.getByRole("button", { name: "Settle Match" });
        if (await s.count()) await s.click().catch(() => {});
      }
    }
    await pa.waitForTimeout(4000);
  }
  log("result A", a, "B", b);
  await pa.waitForTimeout(800);
  await shot(pa, "bp-result-overlay-1920");
  await shot(pb, "bp-result-overlay-390");
  await pa.waitForTimeout(4000);
  await shot(pa, "bp-result-1920");
  await shot(pb, "bp-result-390", true);
  for (const [n, p] of [["A", pa], ["B", pb]]) log(n, "result text:", (await p.locator("main").innerText()).split("\n").filter(Boolean).join(" | ").slice(0, 900));
  log("Block Puzzle Match", id, "settled:", await pa.locator(".mr-status").innerText().catch(() => "?"), "/", await pb.locator(".mr-status").innerText().catch(() => "?"));
}

async function holdem() {
  log("Hold'em: A and B enter the queue");
  for (const [p, dev] of [[pa, A], [pb, B]]) {
    await p.goto(`${BASE}/play/holdem?dev=${dev}`, { waitUntil: "load", timeout: 180000 });
    await settle(p);
    await p.locator("label.entry", { hasText: new RegExp(`^${ENTRY}$`) }).click().catch(() => {});
    await p.getByRole("button", { name: "Play now" }).click();
    await p.waitForURL(/\/play\/match\//, { timeout: 180000 });
    log(dev, "at", p.url());
  }
  await holdemLoop();
}

async function holdemChallenge() {
  log("Hold'em Challenge: A creates it at entry", ENTRY);
  await pa.goto(`${BASE}/play/challenge?game=holdem&entry=${ENTRY}&dev=${A}`, { waitUntil: "load", timeout: 180000 });
  await pa.waitForURL(/\/play\/match\//, { timeout: 180000 });
  const id = pa.url().split("/").pop().split("?")[0];
  log("match", id, "link", await link(pa));
  await shot(pa, "holdem-challenge-link");
  await pb.goto(`${BASE}/play/challenge/${id}?game=holdem&dev=${B}`, { waitUntil: "load", timeout: 180000 });
  await pb.waitForURL(/\/play\/match\//, { timeout: 180000 }).catch(() => {});
  log("B at", pb.url());
  await holdemLoop();
}

async function holdemLoop() {
  const deadline = Date.now() + 15 * 60_000;
  let shotsDone = false;
  while (Date.now() < deadline) {
    if ((await pa.getByRole("heading", { name: "Match result" }).count()) && (await pb.getByRole("heading", { name: "Match result" }).count())) break;
    for (const [p, allIn] of [[pa, true], [pb, false]]) {
      const enabled = await p.locator(".hdx-btn:not(:disabled)").count();
      if (!enabled) continue;
      if (!shotsDone && p === pa) {
        await shot(pa, "holdem-table-1920");
        await shot(pb, "holdem-table-390", true);
        shotsDone = true;
      }
      if (allIn && (await p.locator(".hd-preset:not(:disabled)").count())) {
        await p.getByRole("button", { name: "All-in", exact: true }).click().catch(() => {});
        await p.getByRole("button", { name: /^(Raise|Bet)$/ }).click().catch(() => {});
        log("A all-in");
      } else if (await p.getByRole("button", { name: /^Call/ }).isEnabled().catch(() => false)) {
        await p.getByRole("button", { name: /^Call/ }).click().catch(() => {});
        log("B call");
      } else {
        await p.getByRole("button", { name: "Check" }).click().catch(() => {});
      }
    }
    await pa.waitForTimeout(3000);
  }
  await pa.waitForTimeout(800);
  await shot(pa, "holdem-result-overlay-1920");
  await pa.waitForTimeout(4000);
  await shot(pa, "holdem-result-1920");
  await shot(pb, "holdem-result-390", true);
  for (const [n, p] of [["A", pa], ["B", pb]]) log(n, "result text:", (await p.locator("main").innerText()).split("\n").filter(Boolean).join(" | ").slice(0, 900));
  log("Hold'em", pa.url(), await pa.locator(".mr-status").innerText().catch(() => "?"), "/", await pb.locator(".mr-status").innerText().catch(() => "?"));
}

try {
  if (want("funding")) {
    await fund(pa, A);
    await fund(pb, B);
    await shot(pa, "wallet-funded-1920");
  }
  if (want("bpc")) await bpChallenge();
  if (want("hdc")) await holdemChallenge();
  if (want("bp")) await bpMatch();
  if (want("holdem")) await holdem();
} catch (e) {
  log("FAILED", e.message.split("\n")[0]);
  await shot(pa, "failed-a").catch(() => {});
  await shot(pb, "failed-b").catch(() => {});
  process.exitCode = 1;
}
await browser.close();
