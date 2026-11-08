/**
 * Records the "How to play" guide clips from the real Practice screens (dev fixtures, no chain):
 * public/art/how-to-play/<game>/<n>-<phone|desktop>.{webm,mp4,webp}, for every step of the four Games.
 * Phone set: 390 px wide phone layout, cropped to portrait 4:5. Desktop set: 1440x900 desktop layout, cropped to 16:10.
 * Both sets play the same script. Re-run whenever a game's UI or the step list changes:
 *
 *   NEXT_PUBLIC_DEV_WALLET=1 pnpm --filter @tesoro/app dev            # dev server, e.g. on port 3141
 *   BASE=http://localhost:3141 node scripts/capture-how-to-play.mjs
 *
 * Record on a machine with a fast CPU (the laptop), never the CPU-only VPS: its headless Chromium painted 5 to 19 frames per
 * second on Vanguard's board and the clips looked laggy. A production build of the app with the dev wallet switched on
 * (`NEXT_PUBLIC_DEV_WALLET=1`, and the `NODE_ENV` check dropped from `lib/chain/config.ts` in that copy) loads far faster than
 * `next dev` through an ssh tunnel; run the script with tsx (it imports the app's TypeScript rules).
 * After encoding, every clip is checked for frames that differ from the one before: under MIN_FPS (20) per second the take
 * is thrown away and recorded again, with a message that says whether the browser was too slow or the screen barely moved.
 * Needs playwright-core and ffmpeg (libx264, libvpx-vp9, libwebp) on the machine that records.
 * Env: PW=/path/to/playwright-core, CHROME=/path/to/chrome, FFMPEG=/path/to/ffmpeg, OUT=<output dir>,
 *      ONLY=<game>[:step][,...] (e.g. ONLY=vanguard:3 or ONLY=holdem,trading-duel:1), SETS=phone|desktop.
 *
 * Practice is seeded so a re-run plays the same: `?seed=<n>` fixes Block Burst pieces, Hold'em shuffles and bot,
 * the Vanguard setup and bot, and the Trading Duel price path. Seeds are read only in dev builds
 * (NEXT_PUBLIC_DEV_WALLET=1, `lib/practice-seed.ts`). Trading Duel runs in real time (a whole game is 150 s).
 *
 * Every clip is recorded from its own fresh game: `prep` plays up to the moment the step is about, unrecorded,
 * then `act` plays the moment itself while the screencast runs. A clip is 3 to 8 s (longer takes are sped up),
 * fades in and out so it loops cleanly, and is shrunk until each video is at most 300 KB.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.env.OUT ?? join(HERE, "../public/art/how-to-play"));
const BASE = process.env.BASE ?? "http://localhost:3141";
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE ?? FFMPEG.replace(/ffmpeg$/, "ffprobe");
const MIN_SECS = 3;
const MAX_SECS = 8;
const MAX_KB = 300;
const MIN_FPS = 20;
const SEED = 3;

/**
 * The guide lays its words over the foot of the clip (about 38% of it) and, on desktop, its progress bars over the top (about 10%).
 * `band` is the part of the frame that stays clear: phone 0-60%, desktop 12-62%. A crop puts what the step is about in that band.
 * The crop may reach past the page's bottom or top edge: those rows are filled with the page's dark background (PAGE_FILL).
 */
const EDGE = 700;
const PAGE_FILL = "0x070b10";
const SETS = {
  phone: { context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, ratio: 4 / 5, out: [480, 600], pad: 8, band: [0, 0.6] },
  desktop: { context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, ratio: 16 / 10, out: [960, 600], pad: 12, band: [0.12, 0.62] },
};

const run = (file, args) => promisify(execFile)(file, args, { maxBuffer: 1 << 28 });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const even = (n) => Math.round(n / 2) * 2;

// ---------------------------------------------------------------- shared page helpers

/** Centre of the first element matching `selector` that is on screen. */
async function centre(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

/** Drags with the mouse from one point to another at a steady pace, like a finger (about 0.7 s, in small timed steps). */
async function drag(page, from, to, steps = 36) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k * k * (3 - 2 * k);
    await page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    await sleep(18);
  }
  await sleep(250);
  await page.mouse.up();
}

// ---------------------------------------------------------------- Block Burst

async function bpRead(page) {
  return page.evaluate(() => {
    const occ = [...document.querySelectorAll(".bp-board .bp-cell")].map((c) => c.classList.contains("on"));
    const pieces = [...document.querySelectorAll(".bp-slot")].map((slot, i) => {
      if (slot.disabled || slot.classList.contains("used")) return null;
      const cells = [...slot.querySelectorAll(".bp-mini i")].map((e) => [Number(e.style.gridColumn) - 1, Number(e.style.gridRow) - 1]);
      return cells.length ? { i, cells } : null;
    });
    return { occ, pieces: pieces.filter(Boolean), lines: Number(document.body.innerText.match(/Lines\s+(\d+)/)?.[1] ?? 0) };
  });
}

/** The placement that clears the most lines, else the one that packs the board tightest (`top`: the one nearest the top left, so the pieces land where a short crop sees them). */
function bpBest({ occ, pieces }, top = false) {
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
        const total = top ? -y * 1000 - x : cleared * 1000 + score + touch * 3 + y;
        if (!best || total > best.total) best = { total, piece: p, x, y, w, h, cleared };
      }
    }
  }
  return best;
}

/** Drags the piece onto the board so its top-left cell lands on (x, y). Returns once the piece is used. */
async function bpPlace(page, move, m) {
  const slot = page.locator(".bp-slot").nth(move.piece.i);
  const from = await centre(page, `.bp-slot:nth-child(${move.piece.i + 1})`) ?? (await slot.boundingBox().then((b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })));
  const first = await page.locator(".bp-board .bp-cell").nth(move.y * 8 + move.x).boundingBox();
  const last = await page.locator(".bp-board .bp-cell").nth((move.y + move.h - 1) * 8 + move.x + move.w - 1).boundingBox();
  const to = { x: (first.x + last.x + last.width) / 2, y: (first.y + last.y + last.height) / 2 };
  // an arrow from the piece to where it lands, drawn just before the drag
  const arrow = m ? await m.add({ kind: "arrow", target: `.bp-slot:nth-child(${move.piece.i + 1})`, to: `.bp-board .bp-cell:nth-child(${move.y * 8 + move.x + 1})` }) : null;
  if (m) await sleep(650);
  await drag(page, from, to);
  if (m) await m.remove(arrow);
  await sleep(500);
}

async function bpWaitPlaying(page) {
  await page.waitForSelector(".bp-slot:not(:disabled)", { timeout: 30000 });
  await sleep(600);
}

/** Plays placements that do not clear a line until the next best one would, so that one can be recorded. */
async function bpUntilClear(page) {
  for (let n = 0; n < 24; n++) {
    await page.waitForSelector(".bp-slot:not(:disabled):not(.used)", { timeout: 8000 }).catch(() => {});
    const state = await bpRead(page);
    const move = bpBest(state);
    if (!move) return;
    if (move.cleared > 0) return move;
    await bpPlace(page, move);
  }
}

// ---------------------------------------------------------------- Hold'em

async function hdWaitMyTurn(page, timeout = 30000) {
  const pass = page.locator(".hdx-btn", { hasText: /^(Call|Check)/ });
  await pass.waitFor({ timeout });
  await page.waitForFunction(() => [...document.querySelectorAll(".hdx-btn")].some((b) => /^(Call|Check)/.test(b.textContent) && !b.disabled), null, { timeout });
  return pass;
}

const hdBoardCards = (page) => page.evaluate(() => document.querySelectorAll(".hdx-board .hd-card:not(.empty)").length);

/** Calls or checks until `n` community cards are showing and it is your turn. */
async function hdUntilBoard(page, n) {
  for (let i = 0; i < 60; i++) {
    if ((await hdBoardCards(page)) >= n) {
      await sleep(1200);
      return;
    }
    const pass = await hdWaitMyTurn(page).catch(() => null);
    if (pass) {
      await sleep(700);
      await pass.click().catch(() => {});
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------- Vanguard

const vgMyTurn = (page) => page.waitForFunction(() => document.querySelector(".vg-turn")?.textContent?.includes("Your turn"), null, { timeout: 30000, polling: 200 });

/** Your pieces, the most advanced (nearest the top) first, with their top edge. */
async function vgPieces(page) {
  return page.evaluate(() => [...document.querySelectorAll(".vg-piece.us:not([disabled])")].map((e, i) => ({ i, y: e.getBoundingClientRect().top })).sort((a, b) => a.y - b.y));
}

/**
 * Taps your pieces, most advanced first, until one has a marked square, and returns { piece, mark }.
 * `attack` wants a square with an enemy on it; otherwise the most forward marked square is wanted.
 */
async function vgSelect(page, { attack = false } = {}) {
  const pieces = page.locator(".vg-piece.us:not([disabled])");
  for (const { i, y } of await vgPieces(page)) {
    await pieces.nth(i).click({ force: true, timeout: 800 }).catch(() => {});
    await sleep(120);
    const marks = await page.evaluate((atk) => [...document.querySelectorAll(atk ? ".vg-mark.atk" : ".vg-mark")].map((e, n) => ({ n, y: e.getBoundingClientRect().top })).sort((a, b) => a.y - b.y), attack);
    if (marks.length && (attack || marks[0].y < y)) return { index: i, piece: pieces.nth(i), mark: page.locator(attack ? ".vg-mark.atk" : ".vg-mark").nth(marks[0].n) };
  }
  return null;
}

/** The Italian setup the seed deals (square "r,c" -> rank), from the app's own rules (needs tsx). */
async function vgItalians(seed) {
  const rules = await import("../src/games/vanguard/rules.ts");
  return new Map(rules.newGame(rules.seeded(seed), 0).pieces.filter((p) => p.army === "it").map((p) => [`${p.r},${p.c}`, p.rank]));
}

/** Italian pieces on the board now: square "r,c" -> the rank shown on its label, or null while it is face down. */
const vgEnemies = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".vg-piece.it:not(.gone)")].map((e) => {
    const [c, r] = [...e.getAttribute("style").matchAll(/\* (-?[\d.]+)\)/g)].map((m) => Math.round(Number(m[1])));
    return [`${r},${c}`, e.getAttribute("aria-label").match(/^Italian (\d+|B|F) /)?.[1] ?? null];
  }));

/** Keeps `known` (square -> rank) in step with the board: a piece that left one square and appeared on another took its rank along. */
async function vgTrack(page, known) {
  const now = new Map(await vgEnemies(page));
  const left = [...known.keys()].filter((k) => !now.has(k));
  const came = [...now.keys()].filter((k) => !known.has(k));
  if (left.length === 1 && came.length === 1) { known.set(came[0], known.get(left[0])); known.delete(left[0]); }
  else for (const k of left) known.delete(k);
  for (const [k, rank] of now) if (rank) known.set(k, rank);
}

const vgNum = (r) => (/^\d+$/.test(r ?? "") ? Number(r) : null);

/**
 * Plays unrecorded turns with our highest pieces, walking toward an Italian piece we know is lower, until one of them
 * has a marked attack on a lower rank (a sure win). Leaves that attacker selected and returns its attack mark.
 */
async function vgUntilWin(page, seed) {
  const known = await vgItalians(seed);
  for (let turn = 0; turn < 30; turn++) {
    await vgMyTurn(page);
    await sleep(100);
    await vgTrack(page, known);
    const mine = await page.evaluate(() => [...document.querySelectorAll(".vg-piece.us:not([disabled]):not(.gone)")].map((e, i) => ({ i, rank: e.getAttribute("aria-label").match(/^US (\d+) /)?.[1] })).filter((p) => p.rank).sort((a, b) => b.rank - a.rank));
    const pieces = page.locator(".vg-piece.us:not([disabled]):not(.gone)");
    for (const { i, rank } of mine.filter((p) => Number(p.rank) >= 7 && Number(p.rank) < 10 || p.rank === "10").slice(0, 3)) {
      await pieces.nth(i).click({ force: true, timeout: 800 }).catch(() => {});
      await sleep(120);
      const marks = await page.evaluate(() => [...document.querySelectorAll(".vg-mark")].map((e, n) => ({ n, atk: e.classList.contains("atk"), label: e.getAttribute("aria-label") })));
      const at = (m) => { const [, row, col] = m.label.match(/row (\d+), column (\d+)/); return [10 - Number(row), Number(col) - 1]; };
      const win = marks.find((m) => m.atk && vgNum(known.get(at(m).join(","))) !== null && vgNum(known.get(at(m).join(","))) < Number(rank));
      if (win) return page.locator(".vg-mark").nth(win.n);
      // else step toward the nearest lower Italian piece
      const prey = [...known].filter(([, r]) => vgNum(r) !== null && vgNum(r) < Number(rank)).map(([k]) => k.split(",").map(Number));
      const steps = marks.filter((m) => !m.atk).map((m) => ({ m, sq: at(m) }));
      let best = null;
      for (const st of steps) for (const q of prey) {
        const d = Math.abs(st.sq[0] - q[0]) + Math.abs(st.sq[1] - q[1]);
        if (!best || d < best.d) best = { ...st, d };
      }
      if (best) { await page.locator(".vg-mark").nth(best.m.n).click({ force: true, timeout: 1500 }).catch(() => {}); await sleep(1600); break; }
    }
  }
  return null;
}

// ---------------------------------------------------------------- Vanguard: reading the board and planning

const WADI = (r, c) => (r === 4 || r === 5) && (c === 2 || c === 3 || c === 6 || c === 7);

/** Every piece on the board now: { army, i (index among that army's pieces), r, c, rank (null while face down) }. */
const vgBoard = (page) => page.evaluate(() => {
  const at = (e) => {
    const [c, r] = [...e.getAttribute("style").matchAll(/\* (-?[\d.]+)\)/g)].map((m) => Math.round(Number(m[1])));
    return { r, c };
  };
  const read = (army, re) => [...document.querySelectorAll(`.vg-piece.${army}:not(.gone)`)].map((e, i) => ({ army, i, ...at(e), rank: e.getAttribute("aria-label").match(re)?.[1] ?? null }));
  return [...read("us", /^US (\d+|B|F) /), ...read("it", /^Italian (\d+|B|F) /)];
});

/** Taps our piece `i`, then returns the marked squares as [{ n, r, c, atk }]. */
async function vgTap(page, i) {
  await page.locator(".vg-piece.us:not(.gone)").nth(i).click({ force: true, timeout: 1500 });
  await sleep(250);
  return page.evaluate(() => [...document.querySelectorAll(".vg-mark")].map((e, n) => {
    const [, row, col] = e.getAttribute("aria-label").match(/row (\d+), column (\d+)/);
    return { n, r: 10 - Number(row), c: Number(col) - 1, atk: e.classList.contains("atk") };
  }));
}

/** Taps the mark on square (r, c) of the piece that is selected now. */
const vgGo = (page, marks, r, c) => page.locator(".vg-mark").nth(marks.find((m) => m.r === r && m.c === c).n).click({ force: true, timeout: 1500 });

/** Squares a Recon can land on or attack from `from` in one run (straight lines, stopped by the first piece, the wadis block). */
function reconMoves(from, occ) {
  const out = [];
  for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (let k = 1; k < 10; k++) {
      const r = from.r + dr * k;
      const c = from.c + dc * k;
      if (r < 0 || r > 9 || c < 0 || c > 9 || WADI(r, c)) break;
      const o = occ.get(`${r},${c}`);
      if (o === "us") break;
      out.push({ r, c, atk: o === "it" });
      if (o) break;
    }
  }
  return out;
}

/** The fewest Recon runs from `from` to capture the Truck at `truck` (a run that ends on it), by search; returns { turns, first }. */
function truckPlan(from, truck, occ) {
  const goal = `${truck.r},${truck.c}`;
  let frontier = [{ ...from, first: null }];
  const seen = new Set([`${from.r},${from.c}`]);
  for (let turns = 1; turns <= 4; turns++) {
    const next = [];
    for (const s of frontier) {
      for (const m of reconMoves(s, occ)) {
        const key = `${m.r},${m.c}`;
        const first = s.first ?? m;
        if (key === goal) return { turns, first };
        if (m.atk || seen.has(key)) continue;
        seen.add(key);
        next.push({ r: m.r, c: m.c, first });
      }
    }
    frontier = next;
  }
  return null;
}

/** The Truck's square: the Italian piece the seeded setup made the Truck (pieces keep their order in the page). Null once it is gone. */
async function vgTruckSquare(page, seed) {
  const rules = await import("../src/games/vanguard/rules.ts");
  const index = rules.newGame(rules.seeded(seed), 0).pieces.filter((p) => p.army === "it").findIndex((p) => p.rank === "F");
  return page.evaluate((i) => {
    const e = document.querySelectorAll(".vg-piece.it")[i];
    if (!e || e.classList.contains("gone")) return null;
    const [c, r] = [...e.getAttribute("style").matchAll(/\* (-?[\d.]+)\)/g)].map((m) => Math.round(Number(m[1])));
    return { r, c, index: i };
  }, index);
}

/** Walks an Engineer up the board, unrecorded, until two or more coins touch it. Marks it, and returns its index among our pieces. */
async function vgUntilBlast(page) {
  for (let turn = 0; turn < 16; turn++) {
    await vgMyTurn(page);
    await sleep(100);
    const board = await vgBoard(page);
    const engineers = board.filter((p) => p.army === "us" && p.rank === "3").sort((a, b) => a.r - b.r);
    if (!engineers.length) return null;
    const e = engineers[0];
    const touching = board.filter((p) => p.army === "it" && Math.max(Math.abs(p.r - e.r), Math.abs(p.c - e.c)) <= 1).length;
    if (touching >= 2) {
      await page.evaluate((i) => document.querySelectorAll(".vg-piece.us:not(.gone)")[i].setAttribute("data-htp", "eng"), e.i);
      return e.i;
    }
    const marks = await vgTap(page, e.i);
    const steps = marks.filter((m) => !m.atk).sort((a, b) => a.r - b.r);
    if (!steps.length) return null;
    await vgGo(page, marks, steps[0].r, steps[0].c);
    await sleep(500);
  }
  return null;
}

/** Plays Recon runs, planned by search from the live board, until one takes the Supply Truck. Returns false when the plan cannot work. */
async function vgCaptureTruck(page, seed, stopAt = 0, m = null) {
  for (let turn = 0; turn < 5; turn++) {
    await vgMyTurn(page);
    await sleep(350);
    const board = await vgBoard(page);
    const occ = new Map(board.map((p) => [`${p.r},${p.c}`, p.army]));
    const truck = await vgTruckSquare(page, seed);
    if (!truck) { console.log("  truck: unknown square"); return false; }
    let best = null;
    for (const r of board.filter((p) => p.army === "us" && p.rank === "2")) {
      const plan = truckPlan(r, truck, occ);
      if (plan && (!best || plan.turns < best.plan.turns)) best = { r, plan };
    }
    if (!best) { console.log(`  truck: no Recon plan to ${truck.r},${truck.c} on turn ${turn}`); return false; }
    if (stopAt && best.plan.turns <= stopAt) {
      // tag the Recon and the Truck so the recorder frames the run between them
      await page.evaluate(([i, t]) => {
        document.querySelectorAll(".vg-piece.us:not(.gone)")[i].setAttribute("data-htp", "a");
        document.querySelectorAll(".vg-piece.it")[t].setAttribute("data-htp", "b");
      }, [best.r.i, truck.index]);
      return true;
    }
    console.log(`  truck: turn ${turn} truck ${truck.r},${truck.c} plan ${best.plan.turns} via ${best.plan.first.r},${best.plan.first.c}`);
    const runs = await vgTap(page, best.r.i);
    if (m && best.plan.turns === 1) {
      // name the Recon and the Truck, then draw the run just before it happens
      const tb = await page.locator('[data-htp="b"]').boundingBox();
      const ids = [
        await m.add({ kind: "ring", target: '[data-htp="a"]', shape: "circle", pad: 4 }),
        await m.add({ kind: "label", target: '[data-htp="a"]', text: "Recon", side: "left", gap: 12 }),
        await m.add({ kind: "ring", target: '[data-htp="b"]', shape: "circle", pad: 4 }),
        await m.add({ kind: "label", target: '[data-htp="b"]', text: "Enemy Truck", side: "left", gap: 12 }),
      ];
      await sleep(1500);
      for (const id of ids) await m.remove(id);
      await sleep(250);
      const arrow = await m.add({ kind: "arrow", target: '[data-htp="a"]', to: '[data-htp="b"]' });
      await sleep(700);
      await vgGo(page, runs, best.plan.first.r, best.plan.first.c);
      await m.remove(arrow);
      await m.show({ kind: "label", target: { x: tb.x, y: tb.y, w: tb.width, h: tb.height }, text: "Truck captured", side: "left", gap: 12 }, 1300);
      await sleep(1500);
      return true;
    }
    await sleep(1000);
    await vgGo(page, runs, best.plan.first.r, best.plan.first.c);
    await sleep(1000);
    if (best.plan.turns === 1) {
      await sleep(2800);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- Trading Duel (simulated price)

let tdPath = null;
/** The seeded price path, from the app's own module (needs tsx: it is TypeScript). */
async function tdSim() {
  tdPath ??= await import("../src/games/trading-duel/practice/simPrice.ts").then(async (sim) => ({ sim, grid: await import("../src/games/trading-duel/grid.ts") }));
  return tdPath;
}

/** The band (row, relative to the start price) the simulated line is in at `t` seconds. */
async function tdBand(t, seed) {
  const { sim, grid } = await tdSim();
  const start = 100_00000000n;
  return grid.bandOf(sim.simulatedMid(seed, start, "SOL", t), start, grid.stepFor(start, grid.STEP_PPM.SOL));
}

/** Seconds since the Practice game started, read from the clock on screen (2:29 means 1 s in). */
const tdClock = (page) => page.evaluate(() => {
  const t = document.querySelector(".tg-strip-clock")?.textContent?.trim();
  if (!t || !/^\d:\d\d$/.test(t)) return null;
  const [m, s] = t.split(":").map(Number);
  return 150 - (m * 60 + s);
});

async function tdWaitStart(page) {
  await page.waitForSelector(".tg-cell", { timeout: 60000 });
  await sleep(800);
}

/** Clicks the cell of column `c` in the row that holds band `k` (row 0 is the row the line starts in). */
const tdCell = (page, c, k) => page.evaluateHandle(([col, band]) => [...document.querySelectorAll(`.tg-cell[data-cell^="${col}_"]`)].find((e) => e.dataset.cell === `${col}_${band}`) ?? null, [c, k]);

async function tdPick(page, c, k) {
  const el = (await tdCell(page, c, k)).asElement();
  if (!el) return false;
  await el.click({ force: true, timeout: 2000 }).catch(() => {});
  return true;
}

/** Tags the cell of column c, band k so the recorder can frame it. */
async function tdMark(page, c, k, name = "pick") {
  await page.evaluate(([col, band, id]) => [...document.querySelectorAll(".tg-cell")].find((e) => e.dataset.cell === `${col}_${band}`)?.setAttribute("data-htp", id), [c, k, name]);
}

// ---------------------------------------------------------------- teaching marks (callouts)

/**
 * Teaching marks drawn on top of the game while it records: rings, arrows and short labels, injected into the page so they sit on the
 * real elements (they follow pieces that move) and stay crisp. They are marks, not game UI: off-white strokes and text on a near-black
 * plate with cut corners, emerald only for points. Sizes are given in OUTPUT pixels and scaled by the crop, so a label reads at
 * `LABEL_PX` in the finished clip whatever the zoom.
 */
const LABEL_PX = 20;

const OVERLAY_JS = `(() => {
  if (window.__htp) return;
  const INK = "#EAEFEC", PLATE = "rgba(9,13,15,.85)", EMERALD = "#24D8A8", SHADOW = "rgba(9,13,15,.8)";
  const items = new Map();
  let root = null, svg = null, n = 0, u = 1, raf = 0;
  const font = () => getComputedStyle(document.body).fontFamily;
  const mount = () => {
    if (root) return;
    root = document.createElement("div");
    root.setAttribute("aria-hidden", "true");
    root.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden";
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible";
    root.appendChild(svg);
    document.documentElement.appendChild(root);
  };
  const rectOf = (t) => {
    if (t && typeof t === "object" && !Array.isArray(t)) return { l: t.x, t: t.y, r: t.x + t.w, b: t.y + t.h };
    let box = null;
    for (const spec of [].concat(t)) {
      const [sel, pick] = spec.split("|");
      const all = [...document.querySelectorAll(sel)];
      for (const e of pick === "last" ? all.slice(-1) : pick === "first" ? all.slice(0, 1) : all) {
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        box = box ? { l: Math.min(box.l, r.left), t: Math.min(box.t, r.top), r: Math.max(box.r, r.right), b: Math.max(box.b, r.bottom) } : { l: r.left, t: r.top, r: r.right, b: r.bottom };
      }
    }
    return box;
  };
  const cut = (c) => "polygon(" + c + "px 0,100% 0,100% calc(100% - " + c + "px)," + "calc(100% - " + c + "px) 100%,0 100%,0 " + c + "px)";
  const make = (s) => {
    const el = document.createElement("div");
    el.style.cssText = "position:absolute;opacity:0;transform:scale(.92);transition:opacity .18s ease,transform .18s ease;transform-origin:center";
    if (s.kind === "label") {
      const c = 8 * u, line = 2 * u;
      el.style.clipPath = cut(c);
      el.style.background = INK;
      el.style.padding = line + "px";
      const inner = document.createElement("div");
      inner.textContent = s.text;
      inner.style.cssText = "background:" + PLATE + ";clip-path:" + cut(c - line * 0.6) + ";color:" + (s.emerald ? EMERALD : INK) + ";font:800 " + (s.px * u) + "px/1.1 " + font() + ";letter-spacing:.01em;white-space:nowrap;padding:" + 6 * u + "px " + 12 * u + "px";
      el.appendChild(inner);
    } else if (s.kind === "ring") {
      const w = (s.stroke || 3) * u;
      el.style.border = w + "px solid " + INK;
      el.style.boxShadow = "0 0 0 " + 1.5 * u + "px " + SHADOW + ", inset 0 0 0 " + 1.5 * u + "px " + SHADOW;
      el.style.borderRadius = s.shape === "circle" ? "50%" : 8 * u + "px";
      el.style.boxSizing = "border-box";
    } else if (s.kind === "arrow") {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.style.cssText = "opacity:0;transition:opacity .18s ease";
      const mk = (tag, attrs) => { const e = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const k in attrs) e.setAttribute(k, attrs[k]); g.appendChild(e); return e; };
      const w = 4 * u;
      s.parts = { back: mk("line", { stroke: SHADOW, "stroke-width": w + 3 * u, "stroke-linecap": "round" }), line: mk("line", { stroke: INK, "stroke-width": w, "stroke-linecap": "round" }), headBack: mk("polygon", { fill: SHADOW, stroke: SHADOW, "stroke-width": 3 * u, "stroke-linejoin": "round" }), head: mk("polygon", { fill: INK }) };
      svg.appendChild(g);
      s.g = g;
      return null;
    }
    root.appendChild(el);
    return el;
  };
  const place = (s) => {
    const r = rectOf(s.target);
    if (!r) { if (s.el) s.el.style.opacity = "0"; if (s.g) s.g.style.opacity = "0"; return; }
    if (s.kind === "ring") {
      const pad = (s.pad ?? 5) * u;
      let l = r.l - pad, t = r.t - pad, w = r.r - r.l + 2 * pad, h = r.b - r.t + 2 * pad;
      if (s.shape === "circle") { const d = Math.max(w, h); l -= (d - w) / 2; t -= (d - h) / 2; w = h = d; }
      Object.assign(s.el.style, { left: l + "px", top: t + "px", width: w + "px", height: h + "px" });
    } else if (s.kind === "label") {
      const w = s.el.offsetWidth, h = s.el.offsetHeight, gap = (s.gap ?? 10) * u;
      let l = (r.l + r.r) / 2 - w / 2, t = (r.t + r.b) / 2 - h / 2;
      if (s.side === "above") t = r.t - h - gap;
      else if (s.side === "below") t = r.b + gap;
      else if (s.side === "left") l = r.l - w - gap;
      else if (s.side === "right") l = r.r + gap;
      l += (s.dx || 0) * u; t += (s.dy || 0) * u;
      const m = 6 * u;
      l = Math.min(Math.max(l, m), innerWidth - w - m);
      Object.assign(s.el.style, { left: l + "px", top: t + "px" });
    } else if (s.kind === "arrow") {
      const q = rectOf(s.to);
      if (!q) return;
      const ax = (r.l + r.r) / 2, ay = (r.t + r.b) / 2, bx = (q.l + q.r) / 2, by = (q.t + q.b) / 2;
      const len = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / len, uy = (by - ay) / len;
      const start = (s.startGap ?? 18) * u, end = (s.endGap ?? 14) * u, head = 16 * u;
      const x1 = ax + ux * start, y1 = ay + uy * start, x2 = bx - ux * end, y2 = by - uy * end;
      const bxh = x2 - ux * head, byh = y2 - uy * head, px = -uy * head * 0.55, py = ux * head * 0.55;
      const p = s.parts;
      for (const e of [p.back, p.line]) { e.setAttribute("x1", x1); e.setAttribute("y1", y1); e.setAttribute("x2", bxh); e.setAttribute("y2", byh); }
      const pts = x2 + "," + y2 + " " + (bxh + px) + "," + (byh + py) + " " + (bxh - px) + "," + (byh - py);
      p.head.setAttribute("points", pts); p.headBack.setAttribute("points", pts);
    }
  };
  const tick = () => { for (const s of items.values()) place(s); raf = requestAnimationFrame(tick); };
  window.__htp = {
    add(spec, scale) {
      mount();
      u = scale;
      const s = { ...spec, id: ++n };
      s.el = make(s);
      items.set(s.id, s);
      place(s);
      if (!raf) raf = requestAnimationFrame(tick);
      requestAnimationFrame(() => requestAnimationFrame(() => { if (s.el) { s.el.style.opacity = "1"; s.el.style.transform = "scale(1)"; } if (s.g) s.g.style.opacity = "1"; }));
      return s.id;
    },
    remove(id) {
      const s = items.get(id);
      if (!s) return;
      items.delete(id);
      if (s.el) { s.el.style.opacity = "0"; s.el.style.transform = "scale(.92)"; setTimeout(() => s.el.remove(), 220); }
      if (s.g) { s.g.style.opacity = "0"; setTimeout(() => s.g.remove(), 220); }
    },
    clear() { for (const id of [...items.keys()]) this.remove(id); },
  };
})();`;

/**
 * Marks for one take. `info.k` (output px per CSS px of the crop) sets their size. add() puts one up (it fades in over 180 ms) and
 * returns its id; remove() fades it out; show() does both around a hold of `ms` (at least 1.2 s to be read).
 */
function marks(page, info) {
  const u = 1 / (info.k ?? 1);
  const px = (v) => v;
  return {
    add: (spec) => page.evaluate(([s, scale]) => window.__htp.add(s, scale), [{ px: LABEL_PX, ...spec }, u]),
    remove: (id) => page.evaluate((i) => window.__htp.remove(i), id),
    async show(spec, ms = 1600) {
      const ids = [];
      for (const one of [].concat(spec)) ids.push(await this.add(one));
      await sleep(ms);
      for (const id of ids) await this.remove(id);
      await sleep(200);
    },
    /** After `delay` ms, shows every spec in `specs` together for `hold` ms. Not awaited by the caller: it runs beside the play. */
    async at(delay, specs, hold = 1800) {
      await sleep(delay);
      const ids = [];
      for (const spec of [].concat(specs)) ids.push(await this.add(spec));
      await sleep(hold);
      for (const id of ids) await this.remove(id);
    },
    clear: () => page.evaluate(() => window.__htp?.clear()),
    px,
  };
}

// ---------------------------------------------------------------- the clips

/**
 * One entry per Game, one per step (1 to 5):
 *  - route: the Practice URL query (seed is added);
 *  - prep(page): unrecorded, brings the game to the moment the step is about;
 *  - focus: selectors whose union is what the crop keeps in view (padded, widened to the set's aspect ratio);
 *  - act(page): the recorded play; returns false to throw the take away and try again (next seed);
 *  - speed: plays the recording faster, poster: where (0 to 1) the still comes from.
 */
const waitFor = async (page, fn, timeout = 60000) => page.waitForFunction(fn, null, { timeout, polling: 200 });

/** Waits until the Trading Duel clock shows `t` seconds since the start. */
async function tdUntil(page, t) {
  for (let i = 0; i < 1200; i++) {
    const now = await tdClock(page);
    if (now !== null && now >= t) return now;
    await sleep(150);
  }
  throw new Error(`Trading Duel clock never reached ${t}`);
}

/** Picks the band the simulated line is in at `at` seconds, in column `c`. */
async function tdPickAt(page, c, at, seed) {
  const k = await tdBand(at, seed);
  return tdPick(page, c, k);
}

/** The real Match result screen on fixtures: the "You won" words and the amount, on both layouts. */
const RESULT_FOCUS = [".mr-word", ".mr-amount"];
const RESULT_PAD = { phone: 50, desktop: 70 };

/** Vanguard camera helper: the whole board, with the top of the board below the progress bars and the foot under the words. */
const VG_WHOLE_BOARD = { phone: [0.02, 0.74], desktop: [0.12, 0.98] };

/** A label, with a ring round its target when `ring` is set (`circle` or the default rounded rectangle). */
const tag = (target, text, side, o = {}) => [
  ...(o.ring ? [{ kind: "ring", target, shape: o.ring === "circle" ? "circle" : "rect", pad: o.pad }] : []),
  { kind: "label", target, text, side, gap: o.gap, dx: o.dx, dy: o.dy, emerald: o.emerald },
];

/** The pieces of the Italian army by position, to tell which one moved. */
const vgPositions = (page) => page.evaluate(() => [...document.querySelectorAll(".vg-piece.it")].map((e) => `${e.style.left}|${e.style.top}`));

/** Tags the Italian piece that moved since `before` with data-htp="bot". */
const vgTagMoved = (page, before) => page.evaluate((b) => {
  const els = [...document.querySelectorAll(".vg-piece.it")];
  const i = els.findIndex((e, k) => `${e.style.left}|${e.style.top}` !== b[k] && !e.classList.contains("gone"));
  if (i < 0) return false;
  els[i].setAttribute("data-htp", "bot");
  return true;
}, before);

const GAMES = {
  "block-puzzle": {
    // the bottom four rows of the board and the piece tray: where pieces land, inside the clear band
    focus: { phone: [".bp-board .bp-cell:nth-child(n+33)", ".bp-slot"], desktop: [".bp-board .bp-cell:nth-child(n+41)", ".bp-slot"] },
    steps: {
      // the real Match screen on a fixed Seed: you play the same pieces your opponent gets
      1: {
        route: "/design/play?dev=demo",
        prep: (page) => page.waitForSelector(".bp-board"),
        act: async (page, info) => {
          const m = marks(page, info);
          await m.show(tag(".bp-slot", "Same pieces", "above", { ring: "rect", pad: 6, gap: 16 }), 1900);
          for (let n = 0; n < 2; n++) {
            const state = await bpRead(page);
            const move = bpBest(state);
            if (!move) { console.log("  bp1: no move", JSON.stringify(state.pieces.map((p) => p.cells.length))); break; }
            await bpPlace(page, move, m);
          }
          await sleep(600);
        },
      },
      2: {
        prep: bpWaitPlaying,
        act: async (page, info) => {
          const m = marks(page, info);
          const first = m.at(0, { kind: "label", target: ".bp-slot|first", text: "Drag to place", side: "above", gap: 14 }, 1700);
          for (let n = 0; n < 3; n++) {
            const move = bpBest(await bpRead(page));
            if (!move) break;
            await bpPlace(page, move, m);
          }
          await first;
        },
      },
      3: {
        prep: async (page) => { await bpWaitPlaying(page); page.__move = await bpUntilClear(page); },
        act: async (page, info) => {
          if (!page.__move) return false;
          const m = marks(page, info);
          const mv = page.__move;
          const row = [`.bp-board .bp-cell:nth-child(${mv.y * 8 + 1})`, `.bp-board .bp-cell:nth-child(${mv.y * 8 + 8})`];
          await m.show(tag(row, "Fill the line", "above", { ring: "rect", pad: 4, gap: 12 }), 1700);
          await bpPlace(page, mv, m);
          await m.show({ kind: "label", target: row, text: "Full line", side: "above", gap: 12 }, 1700);
        },
        poster: 0.7,
      },
      // Practice has no opponent: the closest real screen is your own score and the clock counting while you play
      4: {
        prep: bpWaitPlaying,
        act: async (page, info) => {
          const m = marks(page, info);
          const score = m.at(300, tag(".bp-score-n", "Score", "right", { ring: "rect", pad: 4, gap: 12 }), 2400);
          const clock = m.at(3200, tag('[role="timer"]', "Clock", "right", { ring: "circle", pad: 3, gap: 12 }), 2200);
          for (let n = 0; n < 4; n++) {
            const move = bpBest(await bpRead(page), true);
            if (!move) break;
            await bpPlace(page, move);
          }
          await Promise.all([score, clock]);
        },
        focus: [".bp-score-n", '[role="timer"]', ".bp-board .bp-cell:nth-child(-n+16)"],
        pad: { phone: 0, desktop: 100 },
      },
      // the Match result screen on fixtures: the higher score takes the Pot minus Fees
      5: {
        route: "/design/result?case=won&dev=demo",
        focus: RESULT_FOCUS,
        pad: RESULT_PAD,
        prep: () => sleep(1500),
        act: async (page, info) => {
          const m = marks(page, info);
          const l = m.at(900, { kind: "label", target: ".mr-amount", text: "Higher score wins", side: "below", gap: 14 }, 2800);
          await sleep(5000);
          await l;
        },
      },
    },
  },
  holdem: {
    focus: [".hdx-pot", ".hdx-board", ".hd-cards|last"],
    steps: {
      // both stacks: the camera goes from the Bot's down to yours (the whole table on desktop, closing in)
      1: {
        prep: () => sleep(500),
        focus: { phone: [".hd-plaque-text|first"], desktop: [".hd-plaque-text", ".hdx-pot"] },
        pad: { phone: 100, desktop: 500 },
        camera: {
          keys: [
            { focus: { phone: [".hd-plaque-text|first"], desktop: [".hd-plaque-text", ".hdx-pot"] }, pad: { phone: 100, desktop: 500 }, at: 0.15 },
            { focus: { phone: [".hd-plaque-text|last"], desktop: [".hdx-pot", ".hdx-board", ".hd-cards|last"] }, pad: { phone: 100, desktop: 20 }, at: 0.85 },
          ],
        },
        act: async (page, info) => {
          const m = marks(page, info);
          const a = m.at(500, tag(".hd-stack|first", "Bot stack", "right", { ring: "rect", pad: 5, gap: 14 }), 2400);
          const b = m.at(4400, tag(".hd-stack|last", "Your stack", "right", { ring: "rect", pad: 5, gap: 14 }), 2400);
          await sleep(7000);
          await Promise.all([a, b]);
        },
      },
      // your two cards, then the shared cards dealt after you call; the Bot's two stay face down
      2: {
        prep: (page) => hdWaitMyTurn(page),
        pad: { phone: 20, desktop: 40 },
        act: async (page, info) => {
          const m = marks(page, info);
          const mine = m.at(300, tag(".hd-cards|last", "Your cards", "above", { ring: "rect", pad: 5, gap: 14 }), 3200);
          const start = Date.now();
          while ((await hdBoardCards(page)) < 3 && Date.now() - start < 14000) {
            const pass = page.locator(".hdx-btn", { hasText: /^(Call|Check)/ });
            if (await pass.isEnabled().catch(() => false)) { await sleep(1100); await pass.click().catch(() => {}); }
            await sleep(400);
          }
          const shared = m.at(900, tag(".hdx-board", "Shared cards", "above", { ring: "rect", pad: 5, gap: 14 }), 2400);
          await sleep(3800);
          await Promise.all([mine, shared]);
        },
      },
      // the four actions: pick two raise sizes, then call
      3: {
        prep: (page) => hdWaitMyTurn(page),
        focus: [".hdx-actions"],
        pad: { phone: 60, desktop: 60 },
        act: async (page, info) => {
          const m = marks(page, info);
          const clock = m.at(200, tag(".hdx-actions", "30 s to act", "below", { ring: "rect", pad: 4, gap: 12 }), 1900);
          const sizes = m.at(2300, tag(".hd-presets", "Raise size", "above", { gap: 12 }), 2400);
          for (const size of ["+400", "+600", "+200"]) {
            await page.locator(".hd-preset", { hasText: size }).first().click({ timeout: 2000 }).catch(() => {});
            await sleep(1300);
          }
          await page.locator(".hdx-btn", { hasText: /^Call/ }).first().click({ timeout: 2000 }).catch(() => {});
          await sleep(1800);
          await Promise.all([clock, sizes]);
        },
      },
      4: {
        pad: { phone: 20, desktop: 40 },
        maxSecs: 11,
        prep: (page) => hdUntilBoard(page, 5),
        act: async (page, info) => {
          const m = marks(page, info);
          const start = Date.now();
          while (Date.now() - start < 22000) {
            const pass = page.locator(".hdx-btn", { hasText: /^(Call|Check)/ });
            if (await pass.isEnabled().catch(() => false)) { await sleep(150); await pass.click().catch(() => {}); }
            const won = await page.getByText(/wins? [\d,]+ Chips/).evaluateAll((els) => els.some((e) => e.getBoundingClientRect().width > 100)).catch(() => false);
            if (won) break;
            await sleep(250);
          }
          const best = m.at(300, tag(".hdx-board", "Best five", "above", { ring: "rect", pad: 5, gap: 14 }), 2600);
          await sleep(3000);
          await best;
        },
      },
      // the Match result screen on fixtures (a Practice game has no Pot)
      5: {
        route: "/design/result?case=holdem-won&dev=demo",
        focus: RESULT_FOCUS,
        pad: RESULT_PAD,
        prep: () => sleep(1500),
        act: async (page, info) => {
          const m = marks(page, info);
          const l = m.at(900, { kind: "label", target: ".mr-amount", text: "Last stack wins", side: "below", gap: 14 }, 2800);
          await sleep(5000);
          await l;
        },
      },
    },
  },
  "trading-duel": {
    focus: [".tg-head-dot"],
    steps: {
      // the head start clock, then the live price line
      1: {
        prep: tdWaitStart,
        pad: { phone: 130, desktop: 200 },
        camera: {
          keys: [
            { focus: { phone: [".tg-strip-clock"], desktop: [".tg-head-dot"] }, pad: { phone: 120, desktop: 200 }, at: 0.12 },
            { focus: [".tg-head-dot"], pad: { phone: 130, desktop: 200 }, at: 0.7 },
          ],
        },
        act: async (page, info) => {
          const m = marks(page, info);
          const a = m.at(300, { kind: "label", target: ".tg-strip-clock", text: "Head start", side: "below", gap: 14 }, 2200);
          const b = m.at(4400, tag(".tg-head-dot", "Live price", "above", { ring: "circle", pad: 8, gap: 16 }), 2600);
          await sleep(7500);
          await Promise.all([a, b]);
        },
      },
      // tap one box in each column (the row the line starts in, so the boxes sit beside the line)
      2: {
        prep: tdWaitStart,
        pad: { phone: 130, desktop: 200 },
        act: async (page, info) => {
          const m = marks(page, info);
          const rings = [];
          for (const c of [0, 1, 2]) {
            await tdMark(page, c, 0, `pick${c}`);
            await tdPick(page, c, 0);
            rings.push(await m.add({ kind: "ring", target: `[data-htp="pick${c}"]`, pad: 3 }));
            if (c === 0) rings.push(await m.add({ kind: "label", target: `[data-htp="pick0"]`, text: "Your pick", side: "above", gap: 12 }));
            await sleep(c === 0 ? 1900 : 1500);
            if (c === 0) await m.remove(rings.pop());
          }
          await sleep(900);
          for (const id of rings) await m.remove(id);
          await sleep(250);
        },
      },
      // a column locks: the picks turn into locked chips
      3: {
        prep: async (page) => { await tdWaitStart(page); await tdMark(page, 0, 0, "pick0"); await tdPick(page, 0, 0); await tdUntil(page, 13); },
        pad: { phone: 130, desktop: 200 },
        act: async (page, info) => {
          const m = marks(page, info);
          await tdMark(page, 1, 0, "pick1");
          await tdPick(page, 1, 0);
          const hidden = m.at(200, tag('[data-htp="pick1"]', "Hidden", "above", { ring: "rect", pad: 3, gap: 12 }), 2000);
          await tdUntil(page, 20);
          const locks = m.at(0, tag('[data-htp="pick0"]', "Locks in", "above", { ring: "rect", pad: 3, gap: 12 }), 2400);
          await tdUntil(page, 24);
          await Promise.all([hidden, locks]);
        },
      },
      // the line runs through your box: 100 points on the score
      4: {
        prep: async (page, { seed }) => { await tdWaitStart(page); await tdPickAt(page, 0, 35, seed); await tdMark(page, 0, await tdBand(35, seed), "pick"); await tdUntil(page, 30); },
        focus: ['[data-htp="pick"]'],
        pad: { phone: 150, desktop: 200 },
        camera: {
          keys: [
            { focus: ['[data-htp="pick"]'], pad: { phone: 150, desktop: 200 }, at: 0.62 },
            { focus: [".tg-scoreboard-in"], pad: { phone: 100, desktop: 200 }, at: 0.85 },
          ],
        },
        maxSecs: 11,
        act: async (page, info) => {
          const m = marks(page, info);
          const box = m.at(200, tag('[data-htp="pick"]', "Your box", "above", { ring: "rect", pad: 4, gap: 12 }), 4600);
          await tdUntil(page, 38);
          const points = m.at(0, { kind: "label", target: ".tg-score|first", text: "+100", side: "below", gap: 14, emerald: true }, 2200);
          await tdUntil(page, 42);
          await Promise.all([box, points]);
        },
        poster: 0.8,
      },
      // the Match result screen on fixtures (a Practice game has no Pot)
      5: {
        route: "/design/result?case=trading-duel-won&dev=demo",
        focus: RESULT_FOCUS,
        pad: RESULT_PAD,
        prep: () => sleep(1500),
        act: async (page, info) => {
          const m = marks(page, info);
          const l = m.at(900, { kind: "label", target: ".mr-amount", text: "More points wins", side: "below", gap: 14 }, 2800);
          await sleep(5000);
          await l;
        },
      },
    },
  },
  vanguard: {
    focus: [".vg-piece.us", ".vg-plate.us"],
    steps: {
      // your 20 pieces face up, the enemy's coins face down: the camera starts on your ranks and slides up to their coins
      1: {
        prep: (page) => page.waitForSelector(".vg-board"),
        focus: [".vg-piece.us"],
        pad: { phone: 20, desktop: 10 },
        camera: {
          keys: [
            { focus: [".vg-piece.us"], pad: { phone: 20, desktop: 10 }, at: 0.2 },
            { focus: [".vg-piece.it"], pad: { phone: 20, desktop: 10 }, at: 0.85 },
          ],
        },
        act: async (page, info) => {
          const m = marks(page, info);
          const mine = m.at(300, tag(".vg-piece.us", "Your army", "above", { ring: "rect", pad: 5, gap: 14 }), 2600);
          const theirs = m.at(4600, tag(".vg-piece.it", "Hidden enemy", "below", { ring: "rect", pad: 5, gap: 14 }), 2800);
          await sleep(7500);
          await Promise.all([mine, theirs]);
        },
      },
      // the ring round your name runs down while you pick a move; then the view widens and the bot answers
      2: {
        prep: (page) => vgMyTurn(page),
        focus: [".vg-plate.us .vg-ava"],
        pad: { phone: 60, desktop: 140 },
        camera: {
          keys: [
            { focus: [".vg-plate.us .vg-ava"], pad: { phone: 60, desktop: 140 }, at: 0.4 },
            { focus: [".vg-piece.us", ".vg-plate.us"], pad: { phone: 30, desktop: 60 }, at: 0.55 },
            { focus: [".vg-piece.us", ".vg-plate.us"], pad: { phone: 30, desktop: 60 }, at: 0.68 },
            { focus: [".vg-board"], pad: 0, band: VG_WHOLE_BOARD, at: 0.88 },
          ],
        },
        act: async (page, info) => {
          const m = marks(page, info);
          const clock = await m.add(tag(".vg-plate.us .vg-ava", "10 s", "above", { gap: 12 }).at(-1));
          const ring = await m.add({ kind: "ring", target: ".vg-plate.us .vg-ava", shape: "circle", pad: 4 });
          await sleep(4300);
          await m.remove(clock);
          await m.remove(ring);
          await sleep(300);
          const before = await vgPositions(page);
          const mv = await vgSelect(page);
          if (mv) {
            const to = await mv.mark.boundingBox();
            const arrow = await m.add({ kind: "arrow", target: ".vg-piece.us.sel", to: { x: to.x, y: to.y, w: to.width, h: to.height } });
            await sleep(900);
            await mv.mark.click({ force: true, timeout: 1500 }).catch(() => {});
            await sleep(300);
            await m.remove(arrow);
          }
          await sleep(500);
          await waitFor(page, () => document.querySelector(".vg-turn")?.textContent?.includes("Your turn"), 8000).catch(() => {});
          if (await vgTagMoved(page, before)) await m.show(tag('[data-htp="bot"]', "Bot moves", "below", { ring: "circle", pad: 4, gap: 12 }), 1700);
          else await sleep(600);
        },
      },
      // a high rank attacks a lower one, known from the seeded setup: the clash flips the loser face up and ours stays
      3: {
        prep: async (page, { seed }) => { page.__win = await vgUntilWin(page, seed); if (!page.__win) throw new Error("no winning attack reached"); },
        // the attacker is still selected from prep: attack at once, before the turn clock runs out
        act: async (page, info) => {
          const m = marks(page, info);
          const enemies = (await vgEnemies(page)).length;
          const mine = (await page.locator(".vg-piece.us.sel").first().getAttribute("aria-label").catch(() => "")).match(/^US (\d+|10) /)?.[1] ?? "";
          const to = await page.__win.boundingBox();
          const spot = { x: to.x, y: to.y, w: to.width, h: to.height };
          const ring = await m.add(tag(".vg-piece.us.sel", mine ? `Your ${mine}` : "Your piece", "above", { ring: "circle", pad: 4, gap: 12 })[0]);
          const label = await m.add({ kind: "label", target: ".vg-piece.us.sel", text: mine ? `Your ${mine}` : "Your piece", side: "above", gap: 12, px: 9 });
          await sleep(1100);
          const arrow = await m.add({ kind: "arrow", target: ".vg-piece.us.sel", to: spot });
          await sleep(500);
          await page.__win.click({ force: true, timeout: 1500 }).catch(() => {});
          await m.remove(arrow);
          await m.remove(ring);
          await m.remove(label);
          await sleep(1300);
          const lost = await page.evaluate(() => [...document.querySelectorAll(".vg-piece.it.gone")].map((e) => e.getAttribute("aria-label")?.match(/^Italian (\d+|B|F) /)?.[1]).filter(Boolean).at(-1) ?? null);
          await m.show({ kind: "label", target: spot, text: lost ? `${lost} revealed` : "Lower rank", side: "below", gap: 8, px: 9 }, 1300);
          await m.show({ kind: "label", target: spot, text: mine ? `${mine} wins` : "You win", side: "below", gap: 8, px: 9 }, 1300);
          return (await vgEnemies(page)).length === enemies - 1;
        },
        // close on the clash: the attacker and its target, with a few squares round them
        focus: [".vg-piece.us.sel", ".vg-mark.atk"],
        pad: { phone: 95, desktop: 190 },
        // wide for the setup, then in to about 3 squares across for the clash (each piece a quarter of the frame), then back out
        camera: {
          keys: [
            { focus: [".vg-piece.us.sel", ".vg-mark.atk"], pad: { phone: 95, desktop: 190 }, at: 0.0 },
            { focus: [".vg-piece.us.sel", ".vg-mark.atk"], pad: { phone: 8, desktop: 0 }, at: 0.2 },
            { focus: [".vg-piece.us.sel", ".vg-mark.atk"], pad: { phone: 8, desktop: 0 }, at: 0.78 },
            { focus: [".vg-piece.us.sel", ".vg-mark.atk"], pad: { phone: 95, desktop: 190 }, at: 0.95 },
          ],
        },
        speed: 0.75,
        reseed: true,
        poster: 0.75,
      },
      // an Engineer walks up until enemy coins touch it; tapped, its preview squares show; the view drops to its Blast button, presses it, and returns
      4: {
        prep: async (page) => { page.__eng = await vgUntilBlast(page); if (page.__eng === null) throw new Error("no Engineer reached the enemy"); },
        focus: ['[data-htp="eng"]'],
        pad: { phone: 90, desktop: 150 },
        camera: {
          keys: [
            { focus: ['[data-htp="eng"]'], pad: { phone: 90, desktop: 150 }, at: 0.2 },
            { focus: [".vg-plate.us", ".vg-power"], pad: { phone: 40, desktop: 60 }, at: 0.34 },
            { focus: [".vg-plate.us", ".vg-power"], pad: { phone: 40, desktop: 60 }, at: 0.49 },
            { focus: ['[data-htp="eng"]'], pad: { phone: 90, desktop: 150 }, at: 0.64 },
          ],
        },
        act: async (page, info) => {
          const m = marks(page, info);
          const eb = await page.locator('[data-htp="eng"]').boundingBox();
          await vgTap(page, page.__eng);
          const eng = await m.add({ kind: "ring", target: '[data-htp="eng"]', shape: "circle", pad: 5 });
          const engLabel = await m.add({ kind: "label", target: '[data-htp="eng"]', text: "Engineer", side: "above", gap: 30 });
          await sleep(1700);
          await m.remove(eng);
          await m.remove(engLabel);
          await sleep(1300);
          const power = await m.add({ kind: "ring", target: ".vg-power" });
          const powerLabel = await m.add({ kind: "label", target: ".vg-power", text: "Blast", side: "above", gap: 12 });
          await sleep(1400);
          await page.locator(".vg-power").first().click({ force: true, timeout: 1500 });
          await m.remove(power);
          await m.remove(powerLabel);
          await sleep(900);
          await m.show({ kind: "label", target: { x: eb.x - eb.width, y: eb.y - eb.height, w: eb.width * 3, h: eb.height * 3 }, text: "Squares revealed", side: "above", gap: 14 }, 2200);
          await sleep(1000);
        },
        reseed: true,
        poster: 0.85,
      },
      // a Recon runs across the board and takes the Supply Truck (planned from the seeded setup); then the real result screen
      5: {
        prep: async (page, { seed }) => { if (!(await vgCaptureTruck(page, seed, 2))) throw new Error("no Recon route to the Truck"); },
        focus: ['[data-htp]'],
        pad: { phone: 40, desktop: 80 },
        maxSecs: 10,
        // seed 41 deals a Recon with a clear straight run to the Truck (found by search over the seeded setups)
        seed: 41,
        act: async (page, info) => vgCaptureTruck(page, info.seed, 0, marks(page, info)),
        after: {
          route: "/design/result?case=vanguard-won&dev=demo",
          focus: RESULT_FOCUS,
          pad: RESULT_PAD,
          secs: 3200,
          speed: 1,
          run: async (page, info) => {
            const m = marks(page, info);
            await m.at(700, { kind: "label", target: ".mr-amount", text: "Wins the Pot", side: "below", gap: 14 }, 2200);
          },
        },
        poster: 0.85,
      },
    },
  },
};

// ---------------------------------------------------------------- recorder

const only = (process.env.ONLY ?? "").split(",").filter(Boolean).map((s) => s.split(":"));
const wanted = (game, step) => !only.length || only.some(([g, n]) => g === game && (n === undefined || Number(n) === step));
const sets = (process.env.SETS ?? "phone,desktop").split(",");

const HIDE_DEV_UI = "nextjs-portal, [data-nextjs-toast], [data-next-badge-root] { display: none !important; }";

/** The union of `focus` on screen, in CSS px. */
async function focusBox(page, focus) {
  const box = await page.evaluate((sels) => {
    let u = null;
    for (const spec of sels) {
      // "selector|last" keeps only the last match (the second seat at the table is yours)
      const [sel, pick] = spec.split("|");
      const all = [...document.querySelectorAll(sel)];
      for (const e of pick === "last" ? all.slice(-1) : pick === "first" ? all.slice(0, 1) : all) {
        const r = e.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        u = u ? { l: Math.min(u.l, r.left), t: Math.min(u.t, r.top), r: Math.max(u.r, r.right), b: Math.max(u.b, r.bottom) } : { l: r.left, t: r.top, r: r.right, b: r.bottom };
      }
    }
    return u;
  }, focus);
  if (!box) throw new Error(`focus not found: ${focus.join(", ")}`);
  return box;
}

/**
 * Crop rectangle in CSS px: the union of `focus`, padded, then sized to the set's aspect ratio so that it fits the clear band
 * of the clip, and centred on the band's middle (not the frame's). It stays inside the viewport sideways; it may reach EDGE px past
 * the page's top or bottom (the encoder fills that).
 */
async function cropFor(page, focus, set, padOverride, bandOverride) {
  const vp = set.context.viewport;
  const box = await focusBox(page, focus);
  const pad = padOverride ?? set.pad;
  const [b0, b1] = bandOverride ?? set.band;
  let w = box.r - box.l + pad * 2;
  let h = (box.b - box.t + pad * 2) / (b1 - b0);
  if (w / h < set.ratio) w = h * set.ratio;
  else h = w / set.ratio;
  if (w > vp.width) [w, h] = [vp.width, vp.width / set.ratio];
  const x = Math.min(Math.max((box.l + box.r) / 2 - w / 2, 0), vp.width - w);
  const y = Math.min(Math.max((box.t + box.b) / 2 - ((b0 + b1) / 2) * h, -EDGE), vp.height + EDGE - h);
  return { x, y, w, h };
}

/** Width in px of a JPEG file, from its start-of-frame marker. */
function jpgWidth(file) {
  const b = readFileSync(file);
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b.readUInt16BE(i + 7);
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error("not a JPEG");
}

/**
 * Records `fn` as a screencast of `page` and returns a segment: the frames, the crop and, when `camera` is given
 * ({ from: { focus, pad }, to: { focus, pad }, span: [a, b] } in fractions of the clip), a smooth move from one crop to another.
 */
const forSet = (v, name) => (v && !Array.isArray(v) && (v.phone || v.desktop) ? v[name] : v);

async function capture(ctx, page, set, dir, def, fn, info) {
  const crop = await cropFor(page, forSet(def.focus, info.set), set, def.pad?.[info.set]);
  let camera = null;
  if (def.camera) {
    // { keys: [{ focus, pad, band?, at }] } (the crop at each fraction of the clip, held before the first and after the last),
    // or the short form { from, to, span }
    const keys = def.camera.keys ?? [{ ...def.camera.from, at: (def.camera.span ?? [0.05, 0.95])[0] }, { ...def.camera.to, at: (def.camera.span ?? [0.05, 0.95])[1] }];
    camera = [];
    for (const k of keys) {
      const pad = k.pad?.[info.set] ?? k.pad;
      camera.push({ at: k.at, rect: await cropFor(page, forSet(k.focus, info.set), set, typeof pad === "number" ? pad : undefined, Array.isArray(k.band) ? k.band : k.band?.[info.set]) });
    }
  }
  info.k = set.out[0] / Math.max(crop.w, ...(camera ?? []).map((c) => c.rect.w));
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const writes = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", (f) => {
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`);
    writes.push(writeFile(file, Buffer.from(f.data, "base64")));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const vp = set.context.viewport;
  const dsf = set.context.deviceScaleFactor;
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: vp.width * dsf, maxHeight: vp.height * dsf });
  await sleep(300);
  const ok = await fn();
  await sleep(def.tail ?? 400);
  await cdp.send("Page.stopScreencast");
  await Promise.all(writes);
  const rawFps = frames.length > 1 ? (frames.length - 1) / (frames.at(-1).t - frames[0].t) : 0;
  return { ok: ok !== false, frames, rawFps, crop, camera, dir, scale: frames.length ? jpgWidth(frames[0].file) / vp.width : dsf };
}

/** One take: the prepared game, then the recorded act, then (optional) a second screen recorded after it (`after`). */
async function record(browser, game, step, setName, attempt, work) {
  const set = SETS[setName];
  const def = GAMES[game].steps[step];
  const seed = def.seed ?? SEED + (def.reseed ? attempt : 0);
  const ctx = await browser.newContext(set.context);
  await ctx.addInitScript(OVERLAY_JS);
  // Mark every Game's first-Practice guide as seen, so the recording shows the game, not the guide.
  await ctx.addInitScript(() => {
    for (const g of ["block-puzzle", "holdem", "trading-duel", "vanguard"]) localStorage.setItem(`tesoro:how-to-play:${g}`, "1");
  });
  const open = async (route) => {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`  ${game}:${step}:${setName} pageerror: ${e.message}`));
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    await page.addStyleTag({ content: HIDE_DEV_UI });
    return page;
  };
  const page = await open(def.route ?? `/play/practice?game=${game}&dev=demo&seed=${seed}`);
  await sleep(2000);
  const info = { seed, set: setName };
  await def.prep?.(page, info);
  const base = join(work, `${game}-${step}-${setName}-${attempt}`);
  const segments = [];
  const def1 = { ...def, focus: def.focus ?? GAMES[game].focus };
  segments.push(await capture(ctx, page, set, `${base}-a`, def1, () => def.act(page, info), info));
  if (def.after && segments[0].ok) {
    const next = await open(def.after.route);
    await sleep(def.after.settle ?? 1500);
    const def2 = { focus: def.after.focus, pad: def.after.pad, tail: 200, camera: def.after.camera };
    const seg = await capture(ctx, next, set, `${base}-b`, def2, async () => { await Promise.all([sleep(def.after.secs ?? 3500), def.after.run?.(next, info)]); }, info);
    seg.speed = def.after.speed ?? 1;
    seg.poster = def.after.poster;
    segments.push(seg);
  }
  await ctx.close();
  return { ok: segments.every((s) => s.ok), segments };
}

/**
 * The ffmpeg filter that turns one full-viewport frame into the output frame: a fixed crop, or a camera move between two crops.
 * The frame is first padded top and bottom by EDGE px so a crop may reach past the page. The screencast frames are JPEG (full range,
 * BT.601): the last step converts them to limited-range BT.709 yuv420p, the only kind every browser plays.
 */
function frameFilter(seg, set, secs, vp) {
  const [ow, oh] = set.out;
  const { crop, camera, scale } = seg;
  const padPx = Math.round(EDGE * scale);
  const pad = `pad=iw:ih+${2 * padPx}:0:${padPx}:color=${PAGE_FILL}`;
  const fullH = vp.height + 2 * EDGE;
  let move;
  if (!camera) {
    move = `crop=${even(crop.w * scale)}:${even(crop.h * scale)}:${Math.round(crop.x * scale)}:${Math.round((crop.y + EDGE) * scale)},scale=${ow}:${oh}:flags=lanczos`;
  } else {
    const cs = camera.map((k) => ({ t: k.at * secs, w: k.rect.w, cx: k.rect.x + k.rect.w / 2, cy: k.rect.y + k.rect.h / 2 }));
    const track = (get) => {
      let expr = get(cs[0]).toFixed(3);
      for (let i = 0; i + 1 < cs.length; i++) {
        const dt = cs[i + 1].t - cs[i].t;
        const dv = get(cs[i + 1]) - get(cs[i]);
        if (dt <= 0.001 || Math.abs(dv) < 0.001) continue;
        const q = `clip((t-${cs[i].t.toFixed(3)})/${dt.toFixed(3)},0,1)`;
        expr += `+(${dv.toFixed(3)})*(${q}*${q}*(3-2*${q}))`;
      }
      return `(${expr})`;
    };
    const rw = track((c) => c.w);
    const cx = track((c) => c.cx);
    const cy = track((c) => c.cy);
    move = [
      `scale=w='trunc(${ow}*${vp.width}/${rw}/2)*2':h='trunc(${ow}*${fullH}/${rw}/2)*2':eval=frame:flags=bicubic`,
      `crop=${ow}:${oh}:x='${cx}*${ow}/${rw}-${ow / 2}':y='(${cy}+${EDGE})*${ow}/${rw}-${oh / 2}'`,
    ].join(",");
  }
  return `${pad},${move},${LIMITED}`;
}

/** JPEG frames are full range; browsers only play limited-range BT.709 yuv420p (full-range files fail with MEDIA_ERR_DECODE). */
const LIMITED = "scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p";
const COLOUR_TAGS = ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

/** Frames per second of a video that differ from the frame before them (decoded frames compared, so a repeated frame is not counted). */
async function uniqueFps(file) {
  const r = await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", file, "-an", "-f", "framemd5", "-"]);
  const sums = r.stdout.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim());
  const changed = sums.filter((m, i) => i > 0 && m !== sums[i - 1]).length;
  return changed / (sums.length / 30);
}

/** Every video written this run, checked in a real browser window at the end. */
const written = [];

/** The colour format browsers decode: yuv420p, limited range. Anything else fails to play in a normal browser. */
async function assertPlayable(file) {
  const out = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,color_range", "-of", "csv=p=0", file]);
  const [pix, range] = out.stdout.trim().split(",");
  if (pix !== "yuv420p" || range !== "tv") {
    throw new Error(`${file} is ${pix}/${range}, not yuv420p/tv: browsers cannot decode full-range video (fix the colour conversion in frameFilter and the encoder tags)`);
  }
}

/**
 * Plays every video written this run in a HEADED Chromium window (a headless one decodes files that real browsers refuse):
 * currentTime must pass 1 s within 5 s and the element must report no error. Returns the files that did not play.
 */
async function playbackCheck(files) {
  const headed = await chromium.launch({ executablePath: process.env.CHROME, headless: false, args: ["--autoplay-policy=no-user-gesture-required"] });
  const failures = [];
  for (const file of files) {
    const page = await headed.newPage();
    try {
      await page.goto(`file://${file}`);
      const r = await page.evaluate(async () => {
        const v = document.querySelector("video");
        v.muted = true;
        v.setAttribute("playsinline", "");
        await v.play().catch(() => {});
        const t0 = performance.now();
        while (performance.now() - t0 < 5000 && v.currentTime <= 1 && !v.error) await new Promise((ok) => setTimeout(ok, 100));
        return { t: v.currentTime, error: v.error ? v.error.code : null };
      });
      if (r.error || r.t <= 1) failures.push(`${file}: currentTime ${r.t.toFixed(2)}, error ${r.error}`);
    } catch (e) {
      failures.push(`${file}: ${e.message.split("\n")[0]}`);
    }
    await page.close();
  }
  await headed.close();
  return failures;
}

async function encode(game, step, setName, take) {
  const set = SETS[setName];
  const def = GAMES[game].steps[step];
  const vp = set.context.viewport;
  const [ow, oh] = set.out;
  const dest = join(OUT, game);
  mkdirSync(dest, { recursive: true });
  const base = join(dest, `${step}-${setName}`);
  const work = dirname(take.segments[0].dir);

  // one speed-up for the whole clip, enough to fit MAX_SECS
  const reals = take.segments.map((s) => s.frames.at(-1).t - s.frames[0].t);
  const speeds = take.segments.map((s, i) => (i === 0 ? def.speed ?? 1 : s.speed ?? 1));
  const total = reals.reduce((t, r, i) => t + r / speeds[i], 0);
  const squeeze = Math.max(1, total / (def.maxSecs ?? MAX_SECS));
  const secs = total / squeeze;

  // each segment becomes a clean intermediate (crop, camera, 30 fps), then they are joined and faded together
  const parts = [];
  for (const [i, seg] of take.segments.entries()) {
    const speed = speeds[i] * squeeze;
    const segSecs = reals[i] / speed;
    const list = seg.frames.map((f, k) => `file '${f.file}'\nduration ${(Math.max(0.001, seg.frames[k + 1] ? seg.frames[k + 1].t - f.t : 0.2) / speed).toFixed(4)}`);
    list.push(`file '${seg.frames.at(-1).file}'`);
    const concat = join(seg.dir, "frames.txt");
    writeFileSync(concat, list.join("\n"));
    const out = join(seg.dir, "part.mp4");
    await run(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat, "-vf", `fps=30,${frameFilter(seg, set, segSecs, vp)}`, "-an", "-pix_fmt", "yuv420p", ...COLOUR_TAGS, "-c:v", "libx264", "-crf", "10", "-preset", "veryfast", out]);
    parts.push({ out, segSecs });
  }
  const joined = join(work, `${game}-${step}-${setName}-joined.txt`);
  writeFileSync(joined, parts.map((p) => `file '${p.out}'`).join("\n"));
  const fade = `fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, secs - 0.3).toFixed(2)}:d=0.25`;
  const input = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", joined, "-vf", `fps=30,${fade}`, "-an", "-pix_fmt", "yuv420p", ...COLOUR_TAGS];
  const sizes = {};
  for (const [ext, codec, crfs] of [
    ["webm", (crf) => ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(crf), "-row-mt", "1", "-deadline", "good", "-cpu-used", "2"], [32, 36, 40, 44, 48, 52]],
    ["mp4", (crf) => ["-c:v", "libx264", "-crf", String(crf), "-preset", "slow", "-movflags", "+faststart"], [24, 27, 30, 33, 37, 41]],
  ]) {
    for (const crf of crfs) {
      await run(FFMPEG, [...input, ...codec(crf), `${base}.${ext}`]);
      sizes[ext] = Math.round(statSync(`${base}.${ext}`).size / 1024);
      if (sizes[ext] <= MAX_KB) break;
    }
  }
  // the poster: a frame from the segment that holds the point of the step
  const posterSeg = take.segments.find((s) => s.poster !== undefined) ?? take.segments[0];
  const posterAt = posterSeg.frames[Math.min(posterSeg.frames.length - 1, Math.floor(posterSeg.frames.length * (posterSeg.poster ?? def.poster ?? 0.6)))];
  const posterFilter = frameFilter({ ...posterSeg, camera: null, crop: posterSeg.camera ? posterSeg.camera.at(-1).rect : posterSeg.crop }, set, secs, vp).replace(LIMITED, "scale=in_range=pc:out_range=tv,format=yuv420p");
  await run(FFMPEG, ["-y", "-loglevel", "error", "-i", posterAt.file, "-vf", posterFilter, "-frames:v", "1", "-c:v", "libwebp", "-quality", "82", `${base}.webp`]);

  for (const ext of ["webm", "mp4"]) await assertPlayable(`${base}.${ext}`);
  written.push(`${base}.webm`, `${base}.mp4`);
  const fps = await uniqueFps(`${base}.mp4`);
  const warn = secs < MIN_SECS ? "  (SHORT)" : sizes.webm > MAX_KB || sizes.mp4 > MAX_KB ? "  (OVER SIZE)" : "";
  console.log(`${game}/${step}-${setName}: ${ow}x${oh}, ${secs.toFixed(1)} s (x${squeeze.toFixed(2)}), webm ${sizes.webm} KB, mp4 ${sizes.mp4} KB, ${fps.toFixed(1)} unique fps${warn}`);
  if (fps < MIN_FPS) {
    const slow = Math.min(...take.segments.map((s) => s.rawFps)) < MIN_FPS;
    throw new Error(`only ${fps.toFixed(1)} unique frames per second (needs ${MIN_FPS}): ` + (slow
      ? `the browser painted only ${Math.min(...take.segments.map((s) => s.rawFps)).toFixed(1)} frames per second while recording, so it is too slow here (record on a machine with a fast CPU or GPU, not the CPU-only VPS)`
      : "the screen barely moves in this take (add motion, a camera move or a longer act)"));
  }
}

const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "htp-"));
const launch = () => chromium.launch({ executablePath: process.env.CHROME, args: ["--autoplay-policy=no-user-gesture-required"] });
let browser = await launch();
/** The browser, started again if it died (the machine ran short of memory) while a take was recording. */
async function alive() {
  if (!browser.isConnected()) browser = await launch();
  return browser;
}
let failed = 0;
for (const game of Object.keys(GAMES)) {
  for (const step of [1, 2, 3, 4, 5]) {
    if (!wanted(game, step)) continue;
    // both sets play the same script at once
    await Promise.all(
      sets.map(async (setName) => {
        const tries = GAMES[game].steps[step].tries ?? 3;
        for (let attempt = 0; attempt < tries; attempt++) {
          try {
            const take = await record(await alive(), game, step, setName, attempt, work);
            if (!take.ok || take.segments.some((s) => s.frames.length < 4)) {
              console.log(`${game}/${step}-${setName}: take ${attempt} discarded`);
              continue;
            }
            await encode(game, step, setName, take);
            return;
          } catch (e) {
            console.log(`${game}/${step}-${setName}: take ${attempt} failed: ${e.message.split("\n")[0]}`);
          }
        }
        failed++;
        console.log(`${game}/${step}-${setName}: NO CLIP`);
      }),
    );
  }
}
await browser.close();
const unplayable = process.env.NO_PLAYBACK_CHECK ? [] : await playbackCheck(written);
console.log(`playback check (headed Chromium): ${written.length - unplayable.length}/${written.length} videos play`);
for (const f of unplayable) console.log(`  DOES NOT PLAY ${f}`);
failed += unplayable.length;
if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
if (failed) process.exit(1);
