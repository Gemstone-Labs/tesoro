/**
 * Records the landing page's gameplay loops from the real game screens (dev fixtures, no chain):
 * public/art/landing/loop-<game>.{webm,mp4,webp}. Re-run whenever the game UI changes, then copy the
 * sizes it prints into `GAMES` in components/landing/Games.tsx.
 * Frames come from the browser's screencast as PNGs (Playwright's own video is too soft at this size).
 * Needs a dev server with NEXT_PUBLIC_DEV_WALLET=1, playwright-core and ffmpeg (libsvtav1, libx264):
 *
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3131 node scripts/capture-landing-loops.mjs
 *
 * ONLY=holdem records just that loop (comma list); CHROME=/usr/bin/chromium picks the browser binary.
 * Trading Duel practice runs on the live price feed, so it needs network and plays out in real time (about a minute).
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/art/landing");
const BASE = process.env.BASE ?? "http://localhost:3131";
const VIEW = { width: 1600, height: 1000 };
const PAD = 12;

/** Start practice, then tap a piece and board cells (bottom row first, left to right) until it lands; packed rows clear a line or two. */
async function startBlockPuzzle(page) {
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Start practice" }).click();
  await page.waitForSelector(".bp-slot:not(:disabled)", { timeout: 20000 });
  await page.waitForTimeout(800);
}

/** Reads the board and the three pieces from the DOM and picks the placement that clears a line or packs tightest. */
function readBoard(page) {
  return page.evaluate(() => {
    const occ = [...document.querySelectorAll(".bp-board .bp-cell")].map((c) => c.classList.contains("on"));
    const pieces = [...document.querySelectorAll(".bp-slot")].map((slot, i) => {
      if (slot.disabled || slot.classList.contains("used")) return null;
      const cells = [...slot.querySelectorAll(".bp-mini i")].map((e) => [Number(e.style.gridColumn) - 1, Number(e.style.gridRow) - 1]);
      return cells.length ? { i, cells } : null;
    });
    const lines = Number(document.body.innerText.match(/Lines\s+(\d+)/)?.[1] ?? 0);
    return { occ, pieces: pieces.filter(Boolean), lines };
  });
}

function bestMove({ occ, pieces }) {
  let best = null;
  for (const p of pieces) {
    const w = Math.max(...p.cells.map((c) => c[0])) + 1;
    const h = Math.max(...p.cells.map((c) => c[1])) + 1;
    for (let y = 0; y + h <= 8; y++) {
      for (let x = 0; x + w <= 8; x++) {
        const at = p.cells.map(([dx, dy]) => (y + dy) * 8 + x + dx);
        if (at.some((i) => occ[i])) continue;
        const next = occ.slice();
        at.forEach((i) => (next[i] = true));
        let cleared = 0;
        let score = 0;
        for (let r = 0; r < 8; r++) {
          const n = next.slice(r * 8, r * 8 + 8).filter(Boolean).length;
          if (n === 8) cleared++;
          score += n * n;
        }
        for (let c = 0; c < 8; c++) if (next.filter((_, i) => i % 8 === c).every(Boolean)) cleared++;
        const touch = at.reduce((t, i) => {
          const [cx, cy] = [i % 8, Math.floor(i / 8)];
          return t + [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([ax, ay]) => cx + ax < 0 || cx + ax > 7 || cy + ay > 7 || occ[(cy + ay) * 8 + cx + ax]).length;
        }, 0);
        const total = cleared * 1000 + score + touch * 3 + y;
        if (!best || total > best.total) best = { total, piece: p, x: x + Math.floor(w / 2), y: y + Math.floor(h / 2), cleared };
      }
    }
  }
  return best;
}

async function playBlockPuzzle(page) {
  let lines = 0;
  for (let n = 0; n < 20; n++) {
    await page.waitForSelector(".bp-slot:not(:disabled):not(.used)", { timeout: 8000 }).catch(() => {});
    const state = await readBoard(page);
    const move = bestMove(state);
    if (!move) break;
    await page.locator(".bp-slot").nth(move.piece.i).click();
    await page.waitForTimeout(150);
    await page.locator(".bp-board .bp-cell").nth(move.y * 8 + move.x).click({ force: true });
    await page.waitForTimeout(450);
    lines = (await readBoard(page)).lines;
    if (lines >= 4) break;
  }
  await page.waitForTimeout(1200);
}

/** Practice hand against the bot: raise once, then call or check down the streets to the showdown. */
async function playHoldem(page) {
  await page.getByRole("button", { name: "Min", exact: true }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "½ pot", exact: true }).click();
  await page.waitForTimeout(900);
  await page.locator(".hdx-btn", { hasText: /^Raise/ }).click();
  const start = Date.now();
  while (Date.now() - start < HOLDEM_MS) {
    const pass = page.locator(".hdx-btn", { hasText: /^(Call|Check)/ });
    if (await pass.isEnabled().catch(() => false)) {
      await page.waitForTimeout(800);
      await pass.click().catch(() => {});
    }
    const won = await page.getByText(/wins? [\d,]+ Chips/).evaluateAll((els) => els.some((e) => e.getBoundingClientRect().width > 100)).catch(() => false);
    if (won) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(3200);
}
const HOLDEM_MS = Number(process.env.HOLDEM_MS ?? 32000);

/** Practice against the bot on the live price: pick the box under the line in each open column, then watch the line arrive. */
async function startTradingDuel(page) {
  const start = page.getByRole("button", { name: "Start practice" });
  await start.waitFor({ timeout: 60000 });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Start practice" && !b.disabled), null, { timeout: 90000 });
  await start.click();
  await page.waitForSelector(".tg-cell", { timeout: 30000 });
  // Skip most of the head start: the first column locks 20 s in.
  await page.waitForTimeout(7000);
}

async function playTradingDuel(page) {
  for (const c of [0, 1, 2, 3]) {
    const y = await page.evaluate(() => {
      const r = document.querySelector(".tg-head-dot").getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const cell = await page.evaluateHandle(
      ([col, y]) => [...document.querySelectorAll(`.tg-cell[data-cell^="${col}_"]`)].find((e) => {
        const r = e.getBoundingClientRect();
        return r.top <= y && y < r.bottom;
      }),
      [c, y],
    );
    const box = await cell.asElement()?.boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(PICK_EVERY_MS);
  }
  await page.waitForTimeout(2000);
}
/** Each column is picked a few seconds before it locks, so the pick is still next to the line. */
const PICK_EVERY_MS = 10000;

/**
 * Each loop is cropped to the game itself: from the top of `from` to the bottom of `to`, plus PAD.
 * `width` scales the crop down (the screen is dense and the line moves all the time, so full size encodes large).
 * `poster` is where in the recording (0 to 1) the still comes from; the default is the last frame.
 * `speed` plays the recording faster: the script finds each Block Burst placement by trial, slower than a Player.
 */
const LOOPS = [
  { name: "block-puzzle", route: "/play/practice?dev=demo", prep: startBlockPuzzle, from: ".fx-arena", to: ".fx-arena", pad: 0, act: playBlockPuzzle, speed: 1.7, width: 900, poster: 0.62 },
  { name: "holdem", route: "/play/practice?game=holdem&dev=demo", prep: (page) => page.waitForTimeout(3000), from: ".hdx-head", to: ".hdx-actions", act: playHoldem, speed: 1.25, width: 800, poster: 0.55 },
  { name: "trading-duel", route: "/play/practice?game=trading-duel&dev=demo", prep: startTradingDuel, from: ".tg-bar", to: ".tg-stage", act: playTradingDuel, speed: 2.2, width: 1000 },
];

const even = (n) => Math.round(n / 2) * 2;

const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "loops-"));
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
for (const loop of LOOPS.filter((l) => !process.env.ONLY || process.env.ONLY.split(",").includes(l.name))) {
  const ctx = await browser.newContext({ viewport: VIEW });
  const page = await ctx.newPage();
  // Practice pages keep feeds open, so the network never goes idle.
  await page.goto(`${BASE}${loop.route}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await loop.prep?.(page);
  await page.waitForSelector(loop.from, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const crop = await page.evaluate(
    ([from, to, pad]) => {
      const a = document.querySelector(from).getBoundingClientRect();
      const b = document.querySelector(to).getBoundingClientRect();
      const x = Math.min(a.left, b.left) - pad;
      const y = a.top - pad;
      return { x, y, w: Math.max(a.right, b.right) + pad - x, h: b.bottom + pad - y };
    },
    [loop.from, loop.to, loop.pad ?? PAD],
  );

  // The screencast sends a frame only when the page repaints, so each frame is held until the next one.
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", (f) => {
    const file = join(work, `${loop.name}-${String(frames.length).padStart(5, "0")}.png`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: VIEW.width, maxHeight: VIEW.height });
  await page.waitForTimeout(300);
  await loop.act(page);
  await cdp.send("Page.stopScreencast");
  await ctx.close();

  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1] ? frames[i + 1].t - f.t : 0.3) / loop.speed).toFixed(4)}`);
  list.push(`file '${frames.at(-1).file}'`);
  const concat = join(work, `${loop.name}.txt`);
  writeFileSync(concat, list.join("\n"));

  const [cw, ch] = [even(crop.w), even(crop.h)];
  const [w, h] = loop.width ? [loop.width, even((ch * loop.width) / cw)] : [cw, ch];
  const vf = `crop=${cw}:${ch}:${Math.round(crop.x)}:${Math.round(crop.y)}${loop.width ? `,scale=${w}:${h}:flags=lanczos` : ""},fps=30`;
  const cut = ["-y", "-f", "concat", "-safe", "0", "-i", concat, "-vf", vf, "-an", "-pix_fmt", "yuv420p"];
  const out = (ext) => resolve(OUT, `loop-${loop.name}.${ext}`);
  execFileSync("ffmpeg", [...cut, "-c:v", "libsvtav1", "-crf", loop.width ? "42" : "34", "-preset", "6", out("webm")], { stdio: "ignore" });
  execFileSync("ffmpeg", [...cut, "-c:v", "libx264", "-crf", loop.width ? "30" : "24", "-movflags", "+faststart", out("mp4")], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-i", frames[Math.floor(frames.length * (loop.poster ?? 1)) - (loop.poster ? 0 : 1)].file, "-vf", vf.replace(",fps=30", ""), "-frames:v", "1", "-c:v", "libwebp", "-quality", "86", out("webp")], { stdio: "ignore" });
  console.log(`loop-${loop.name}: ${w}x${h}, ${((frames.at(-1).t - frames[0].t) / loop.speed).toFixed(1)} s`);
}
await browser.close();
rmSync(work, { recursive: true, force: true });
