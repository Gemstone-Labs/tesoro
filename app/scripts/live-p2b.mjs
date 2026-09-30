/**
 * Live proof on Solana devnet with two dev wallets (NEXT_PUBLIC_DEV_WALLET=1): fund each through the
 * native Position flow, play one real Block Puzzle Match and one real Hold'em hand to the result.
 * Player A is a 1920x1200 browser, player B a 390x844 one; screens go to docs/screens/p2b-live-*.png.
 *
 *   PW=/path/to/playwright-core BASE=http://localhost:3120 node scripts/live-p2b.mjs [funding|bp|holdem]
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens");
const BASE = process.env.BASE ?? "http://localhost:3120";
const A = process.env.A ?? "p2bA";
const B = process.env.B ?? "p2bB";
const only = process.argv[2]?.split(",");
const want = (s) => !only || only.includes(s);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
const mk = async (w, h) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  return ctx.newPage();
};
const pa = await mk(1920, 1200);
const pb = await mk(390, 844);
const shot = async (p, name, full = false) => p.screenshot({ path: `${OUT}/p2b-live-${name}.png`, fullPage: full });

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

async function bpMatch() {
  log("Block Puzzle: A enters the queue");
  await pa.goto(`${BASE}/play/block-puzzle?dev=${A}`, { waitUntil: "load", timeout: 180000 });
  await pa.getByRole("button", { name: "Play now" }).click();
  await pa.waitForURL(/\/play\/match\//, { timeout: 180000 });
  const id = pa.url().split("/").pop();
  log("match", id);
  const start = pa.getByRole("button", { name: /Start run/ });
  await start.waitFor({ timeout: 180000 });
  await shot(pa, "bp-ready");
  log("B joins the same Match");
  await pb.goto(`${BASE}/play/block-puzzle?dev=${B}`, { waitUntil: "load", timeout: 180000 });
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
  log("Block Puzzle Match", id, "settled:", await pa.locator(".mr-status").innerText().catch(() => "?"), "/", await pb.locator(".mr-status").innerText().catch(() => "?"));
}

async function holdem() {
  log("Hold'em: A and B enter the queue");
  for (const [p, dev] of [[pa, A], [pb, B]]) {
    await p.goto(`${BASE}/play/holdem?dev=${dev}`, { waitUntil: "load", timeout: 180000 });
    await p.getByRole("radio", { name: /500/ }).check({ force: true }).catch(() => {});
    await p.getByRole("button", { name: "Play now" }).click();
    await p.waitForURL(/\/play\/match\//, { timeout: 180000 });
    log(dev, "at", p.url());
  }
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
  log("Hold'em", pa.url(), await pa.locator(".mr-status").innerText().catch(() => "?"), "/", await pb.locator(".mr-status").innerText().catch(() => "?"));
}

try {
  if (want("funding")) {
    await fund(pa, A);
    await fund(pb, B);
    await shot(pa, "wallet-funded-1920");
  }
  if (want("bp")) await bpMatch();
  if (want("holdem")) await holdem();
} catch (e) {
  log("FAILED", e.message.split("\n")[0]);
  await shot(pa, "failed-a").catch(() => {});
  await shot(pb, "failed-b").catch(() => {});
  process.exitCode = 1;
}
await browser.close();
