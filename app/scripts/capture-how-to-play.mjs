/**
 * Records the "How to play" guide clips from the real Practice screens (dev fixtures, no chain):
 * public/art/how-to-play/<game>/<n>-<phone|desktop>.{webm,mp4,webp}, for every step of the four Games.
 * Phone set: 390 px wide phone layout, cropped to portrait 4:5. Desktop set: 1440x900 desktop layout, cropped to 16:10.
 * Both sets play the same script. Re-run whenever a game's UI or the step list changes.
 *
 * HOW IT RECORDS (60 fps). The screen is recorded, not the browser's screencast (which delivers an animation as one or two changed
 * frames, so cards and chips teleport). `htp-screen.mjs` makes a hidden Hyprland output and starts a kiosk Chromium on it with the
 * GPU compositing the page; `wf-recorder` records that output at 60 fps. The camera is a CSS transform on the page root, eased in the
 * page, and the clip is a fixed crop of the screen. A magenta cover marks the start and the end of each take in the video.
 *
 *   # the app: a production build of this worktree with the dev wallet on, served where BASE can reach it
 *   #   (`NEXT_PUBLIC_DEV_WALLET=1`, and the `NODE_ENV` check dropped from `lib/chain/config.ts` in that copy)
 *   BASE=http://localhost:3178 PW=<playwright-core dir> WFR=<wf-recorder> tsx scripts/capture-how-to-play.mjs
 *
 * Run it with tsx (it imports the app's TypeScript rules). Needs Hyprland, wf-recorder, Chromium, playwright-core and ffmpeg
 * (libx264, libvpx-vp9, libwebp). It never touches the person's own windows or workspaces and removes its output when done.
 * Env: PW, CHROME, FFMPEG, WFR, OUT=<output dir>, ONLY=<game>[:step][,...] (e.g. ONLY=vanguard:3 or ONLY=holdem,trading-duel:1),
 *      SETS=phone|desktop, NO_PLAYBACK_CHECK=1, KEEP=1.
 *
 * Practice is seeded so a re-run plays the same: `?seed=<n>` fixes Block Burst pieces, Hold'em shuffles and bot,
 * the Vanguard setup and bot, and the Trading Duel price path. Seeds are read only in dev builds. Trading Duel runs in real time.
 *
 * Every clip is recorded from its own fresh game: `prep` plays up to the moment the step is about, unrecorded,
 * then `act` plays the moment itself while the screen is recorded. Each clip fades in and out so it loops cleanly, is encoded at
 * 60 fps as limited-range BT.709 yuv420p, and is shrunk until each video is at most 300 KB. After encoding, a clip is thrown away
 * and recorded again if it has under MIN_FPS unique frames per second or fails the motion-continuity check (motion-continuity.mjs).
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OUTPUT, SCREENS, screenDown, screenEnv, screenUp } from "./htp-screen.mjs";
import { MAX_SHARE, continuity, frameDiffs } from "./motion-continuity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.env.OUT ?? join(HERE, "../public/art/how-to-play"));
const BASE = process.env.BASE ?? "http://localhost:3141";
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE ?? FFMPEG.replace(/ffmpeg$/, "ffprobe");
const MIN_SECS = 3;
const MAX_SECS = 12;
const MAX_KB = 300;
const MIN_FPS = 20;
const SEED = 3;

/**
 * The guide lays its words over the foot of the clip (about 38% of it) and, on desktop, its progress bars over the top (about 10%).
 * `band` is the part of the frame that stays clear: phone 0-60%, desktop 12-62%. A crop puts what the step is about in that band.
 */
const EDGE = 700;
const SETS = {
  phone: { context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }, ratio: 4 / 5, out: [480, 600], pad: 8, band: [0, 0.6] },
  desktop: { context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }, ratio: 16 / 10, out: [960, 600], pad: 12, band: [0.12, 0.62] },
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

/**
 * Drags with the mouse from one point to another at a steady pace, like a finger (about 0.8 s). The pointer moves are sent on a
 * 60 Hz clock without waiting for each reply (a reply takes 10 to 20 ms, which would halve the rate), so the piece moves on every frame.
 */
async function drag(page, from, to, steps = 48) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const t0 = performance.now();
  const sent = [];
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k * k * (3 - 2 * k);
    const at = t0 + (i * 1000) / 60;
    sent.push(new Promise((ok) => setTimeout(() => page.mouse.move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e).then(ok, ok), Math.max(0, at - performance.now()))));
  }
  await Promise.all(sent);
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

/** The board cells (indexes) of the row or column that `move` completes. */
function bpLine({ occ }, move) {
  const next = occ.slice();
  for (const [dx, dy] of move.piece.cells) next[(move.y + dy) * 8 + move.x + dx] = true;
  for (let r = 0; r < 8; r++) if (next.slice(r * 8, r * 8 + 8).every(Boolean) && !occ.slice(r * 8, r * 8 + 8).every(Boolean)) return Array.from({ length: 8 }, (_, c) => r * 8 + c);
  for (let c = 0; c < 8; c++) if (next.filter((_, i) => i % 8 === c).every(Boolean) && !occ.filter((_, i) => i % 8 === c).every(Boolean)) return Array.from({ length: 8 }, (_, r) => r * 8 + c);
  return [];
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
async function vgCaptureTruck(page, seed, stopAt = 0, m = null, cam = null, look = null) {
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
      // 0.3 s: name the Recon (camera on it), then the Truck (camera pans), then the whole run, then the capture
      const tb = await page.locator('[data-htp="b"]').boundingBox();
      await sleep(900);
      await cam.to(1, 0.7);
      await sleep(800);
      await m.show([{ kind: "label", target: '[data-htp="b"]', text: "Enemy Truck", side: "below", gap: 4 }], 1500);
      await cam.to(2, 0.7);
      await sleep(800);
      const arrow = await m.add({ kind: "arrow", target: '[data-htp="a"]', to: '[data-htp="b"]' });
      await sleep(900);
      await cam.to(1, 0.8);
      await vgGo(page, runs, best.plan.first.r, best.plan.first.c);
      await m.remove(arrow);
      await sleep(700);
      await m.show({ kind: "label", target: { x: tb.x, y: tb.y, w: tb.width, h: tb.height }, text: "Truck captured", side: "below", gap: 4 }, 1400);
      // the game's own ending: its "You won" dialog
      await cam.to(2, 0.8);
      for (let i = 0; i < 40 && !(await page.locator(".vg-end").count()); i++) await sleep(250);
      if (!(await page.locator(".vg-end").count())) return false;
      await look([".vg-end"], { phone: 30, desktop: 60 }, 0.8);
      await sleep(3000);
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

async function tdPick(page, c, k, { far = false } = {}) {
  const el = (await tdCell(page, c, k)).asElement();
  if (!el) return false;
  // a column that is off screen (to the right of a phone) cannot be clicked at its centre: click it from the page instead
  if (far) await el.evaluate((e) => e.click());
  else await el.click({ force: true, timeout: 2000 }).catch(() => {});
  return true;
}

/** Tags the cell of column c, band k so the recorder can frame it. */
async function tdMark(page, c, k, name = "pick") {
  await page.evaluate(([col, band, id]) => [...document.querySelectorAll(".tg-cell")].find((e) => e.dataset.cell === `${col}_${band}`)?.setAttribute("data-htp", id), [c, k, name]);
}

// ---------------------------------------------------------------- teaching marks (callouts) and the in-page camera

/**
 * The page records itself: the clip is a fixed crop of the screen (C), and the camera is a CSS transform on the page root, eased by the
 * browser's frame loop, so a pan or zoom renders at 60 fps with sub-pixel precision. `__htp.camera.set(rect)` and `.go(rect, seconds)`
 * take a rect in unzoomed page pixels (what the clip should show); the transform that fits that rect into C is derived from it.
 *
 * Marks (rings, arrows, labels) are drawn in screen pixels, on a layer that cancels the page transform, so they stay one size in the
 * finished clip whatever the zoom, sit on the real elements (positions come from their live bounding boxes) and stay inside C and
 * the clear band. They are off-white strokes and text on a near-black plate with cut corners, emerald only for points.
 * Label text is LABEL_PX output px tall (cap height about 0.7 of that).
 */
const LABEL_PX = { phone: 40, desktop: 46 };

const OVERLAY_JS = `(() => {
  if (window.__htp) return;
  const INK = "#EAEFEC", PLATE = "rgba(9,13,15,.88)", EMERALD = "#24D8A8", SHADOW = "rgba(9,13,15,.85)";
  const items = new Map();
  let root = null, svg = null, cover = null, n = 0, raf = 0;
  const cfg = { C: { x: 0, y: 0, w: innerWidth, h: innerHeight }, out: [480, 600], band: [0, 0.6] };
  const cam = { s: 1, tx: 0, ty: 0, seg: null };
  const font = () => getComputedStyle(document.body).fontFamily;
  const smoother = (q) => q * q * q * (q * (q * 6 - 15) + 10);
  let html = null;
  const mount = () => {
    if (root) return;
    html = document.documentElement;
    html.style.transformOrigin = "0 0";
    if (!window.__htpNoWillChange) html.style.willChange = "transform";
    html.style.background = "#070b10";
    root = document.createElement("div");
    root.setAttribute("aria-hidden", "true");
    root.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;transform-origin:0 0";
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible";
    root.appendChild(svg);
    cover = document.createElement("div");
    cover.style.cssText = "position:absolute;left:-5000px;top:-5000px;width:20000px;height:20000px;background:#ff00ff;display:none";
    root.appendChild(cover);
    html.appendChild(root);
  };
  /** A view rect (unzoomed page px) as the camera state that fits it into C. */
  const stateOf = (r) => { const s = cfg.C.w / r.w; return { s, tx: cfg.C.x - r.x * s, ty: cfg.C.y - r.y * s }; };
  const viewOf = (st) => ({ x: (cfg.C.x - st.tx) / st.s, y: (cfg.C.y - st.ty) / st.s, w: cfg.C.w / st.s });
  const apply = () => {
    html.style.transform = "matrix(" + cam.s + ",0,0," + cam.s + "," + cam.tx + "," + cam.ty + ")";
    root.style.transform = "matrix(" + 1 / cam.s + ",0,0," + 1 / cam.s + "," + -cam.tx / cam.s + "," + -cam.ty / cam.s + ")";
  };
  const step = () => {
    if (cam.seg) {
      const q = Math.min(1, (performance.now() - cam.seg.t0) / cam.seg.ms);
      const e = smoother(q), a = cam.seg.from, b = cam.seg.to;
      const v = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, w: a.w + (b.w - a.w) * e };
      Object.assign(cam, stateOf({ x: v.x, y: v.y, w: v.w }));
      if (q >= 1) cam.seg = null;
      apply();
    }
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
      const inner = document.createElement("div");
      inner.textContent = s.text;
      el.appendChild(inner);
      s.inner = inner;
    } else if (s.kind === "ring") {
      el.style.boxSizing = "border-box";
    } else if (s.kind === "arrow") {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.style.cssText = "opacity:0;transition:opacity .18s ease";
      const mk = (tag, attrs) => { const e = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const k in attrs) e.setAttribute(k, attrs[k]); g.appendChild(e); return e; };
      s.parts = { back: mk("line", { stroke: SHADOW, "stroke-linecap": "round" }), line: mk("line", { stroke: INK, "stroke-linecap": "round" }), headBack: mk("polygon", { fill: SHADOW, stroke: SHADOW, "stroke-linejoin": "round" }), head: mk("polygon", { fill: INK }) };
      svg.appendChild(g);
      s.g = g;
      return null;
    }
    root.appendChild(el);
    return el;
  };
  const place = (s) => {
    const C = cfg.C, u = C.w / cfg.out[0];
    const r = rectOf(s.target);
    const visible = r && r.r > C.x && r.l < C.x + C.w && r.b > C.y && r.t < C.y + C.h;
    if (!visible) { if (s.el) s.el.style.visibility = "hidden"; if (s.g) s.g.style.visibility = "hidden"; return; }
    if (s.el) s.el.style.visibility = "visible";
    if (s.g) s.g.style.visibility = "visible";
    if (s.kind === "ring") {
      const w = (s.stroke || 4) * u, pad = (s.pad ?? 5) * u;
      let l = r.l - pad, t = r.t - pad, bw = r.r - r.l + 2 * pad, bh = r.b - r.t + 2 * pad;
      if (s.shape === "circle") { const d = Math.max(bw, bh); l -= (d - bw) / 2; t -= (d - bh) / 2; bw = bh = d; }
      s.el.style.border = w + "px solid " + INK;
      s.el.style.boxShadow = "0 0 0 " + 2 * u + "px " + SHADOW + ", inset 0 0 0 " + 2 * u + "px " + SHADOW;
      s.el.style.borderRadius = s.shape === "circle" ? "50%" : 10 * u + "px";
      Object.assign(s.el.style, { left: l + "px", top: t + "px", width: bw + "px", height: bh + "px" });
    } else if (s.kind === "label") {
      const c = 14 * u, line = 4 * u;
      s.el.style.clipPath = cut(c);
      s.el.style.background = INK;
      s.el.style.padding = line + "px";
      s.inner.style.cssText = "background:" + PLATE + ";clip-path:" + cut(c - line * 0.6) + ";color:" + (s.emerald ? EMERALD : INK) + ";font:800 " + s.px * u + "px/1.1 " + font() + ";letter-spacing:.01em;white-space:nowrap;padding:" + 8 * u + "px " + 18 * u + "px";
      const w = s.el.offsetWidth, h = s.el.offsetHeight, gap = (s.gap ?? 14) * u;
      let l = (r.l + r.r) / 2 - w / 2, t = (r.t + r.b) / 2 - h / 2;
      if (s.side === "above") t = r.t - h - gap;
      else if (s.side === "below") t = r.b + gap;
      else if (s.side === "left") l = r.l - w - gap;
      else if (s.side === "right") l = r.r + gap;
      l += (s.dx || 0) * u; t += (s.dy || 0) * u;
      const m = 6 * u, b0 = C.y + cfg.band[0] * C.h, b1 = C.y + cfg.band[1] * C.h;
      l = Math.min(Math.max(l, C.x + m), C.x + C.w - w - m);
      t = Math.min(Math.max(t, b0 + m), b1 - h - m);
      Object.assign(s.el.style, { left: l + "px", top: t + "px" });
    } else if (s.kind === "arrow") {
      const q = rectOf(s.to);
      if (!q) return;
      const ax = (r.l + r.r) / 2, ay = (r.t + r.b) / 2, bx = (q.l + q.r) / 2, by = (q.t + q.b) / 2;
      const len = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / len, uy = (by - ay) / len;
      const start = (s.startGap ?? 24) * u, end = (s.endGap ?? 18) * u, head = 24 * u;
      const x1 = ax + ux * start, y1 = ay + uy * start, x2 = bx - ux * end, y2 = by - uy * end;
      const bxh = x2 - ux * head, byh = y2 - uy * head, px = -uy * head * 0.55, py = ux * head * 0.55;
      const p = s.parts, w = 5 * u;
      p.back.setAttribute("stroke-width", w + 4 * u); p.line.setAttribute("stroke-width", w); p.headBack.setAttribute("stroke-width", 4 * u);
      for (const e of [p.back, p.line]) { e.setAttribute("x1", x1); e.setAttribute("y1", y1); e.setAttribute("x2", bxh); e.setAttribute("y2", byh); }
      const pts = x2 + "," + y2 + " " + (bxh + px) + "," + (byh + py) + " " + (bxh - px) + "," + (byh - py);
      p.head.setAttribute("points", pts); p.headBack.setAttribute("points", pts);
    }
  };
  const stamps = [];
  const tick = (now) => { stamps.push(now); step(); for (const s of items.values()) place(s); raf = requestAnimationFrame(tick); };
  window.__htp = {
    /** Sets the crop C (screen px), the output size and the clear band, and starts the frame loop. */
    init(c) { Object.assign(cfg, c); mount(); Object.assign(cam, { s: 1, tx: 0, ty: 0, seg: null }); apply(); if (!raf) raf = requestAnimationFrame(tick); },
    camera: {
      set(r) { Object.assign(cam, stateOf(r), { seg: null }); apply(); },
      go(r, secs) { cam.seg = { from: viewOf(cam), to: r, t0: performance.now(), ms: Math.max(1, secs * 1000) }; },
    },
    /** Seconds between the page's own frames since reset: shows whether the browser kept 60 fps while recording. */
    frames(reset) { const d = stamps.slice(1).map((v, i) => v - stamps[i]); if (reset) stamps.length = 0; return d; },
    /** A screen-pixel box {l,t,r,b} as unzoomed page pixels (undoes the camera), so crops can be planned mid-take. */
    unproject(r) { return { l: (r.l - cam.tx) / cam.s, t: (r.t - cam.ty) / cam.s, r: (r.r - cam.tx) / cam.s, b: (r.b - cam.ty) / cam.s }; },
    cover(on) { cover.style.display = on ? "block" : "none"; },
    add(spec) {
      mount();
      const s = { ...spec, id: ++n };
      s.el = make(s);
      items.set(s.id, s);
      place(s);
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
 * Marks for one take. add() puts one up (it fades in over 180 ms) and returns its id; remove() fades it out; show() does both around a
 * hold of `ms` (at least 1.2 s to be read); at() does that after a delay without holding up the play.
 */
function marks(page, info) {
  const px = LABEL_PX[info.set];
  return {
    add: (spec) => page.evaluate((s) => window.__htp.add(s), { px, ...spec }),
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

/** The band the simulated line spends the most time in during column `c` (its window is 30 + 10c to 40 + 10c seconds). */
async function tdBestBand(c, seed) {
  const counts = new Map();
  for (let t = 30 + 10 * c + 0.5; t < 40 + 10 * c; t += 0.5) {
    const k = await tdBand(t, seed);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].sort((x, y) => y[1] - x[1])[0][0];
}

/** Picks the band the simulated line is in at `at` seconds, in column `c`. */
async function tdPickAt(page, c, at, seed) {
  const k = await tdBand(at, seed);
  return tdPick(page, c, k);
}

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
            const move = bpBest(await bpRead(page));
            if (!move) break;
            await bpPlace(page, move);
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
            await bpPlace(page, move);
          }
          await first;
        },
      },
      // the piece that completes a line: the line it will complete is marked before the drag
      3: {
        prep: async (page) => {
          await bpWaitPlaying(page);
          page.__move = await bpUntilClear(page);
          if (!page.__move) return;
          page.__line = bpLine(await bpRead(page), page.__move);
          await page.evaluate((cells) => cells.forEach((i) => document.querySelectorAll(".bp-board .bp-cell")[i]?.setAttribute("data-htp", "line")), page.__line);
        },
        focus: { phone: ['[data-htp="line"]', ".bp-slot"], desktop: ['[data-htp="line"]'] },
        pad: { phone: 20, desktop: 120 },
        act: async (page, info) => {
          if (!page.__move || !page.__line?.length) return false;
          const m = marks(page, info);
          await m.show(tag('[data-htp="line"]', "Fill the line", "above", { ring: "rect", pad: 4, gap: 12 }), 1700);
          await bpPlace(page, page.__move);
          await sleep(2200);
        },
        poster: 0.7,
      },
      // Practice has no opponent: the closest real screen is your own score and the clock counting while you play
      4: {
        prep: async (page) => { await bpWaitPlaying(page); page.__move = await bpUntilClear(page); },
        focus: [".bp-score-n"],
        pad: { phone: 40, desktop: 60 },
        camera: {
          cues: [
            { focus: [".bp-score-n"], pad: { phone: 40, desktop: 60 }, band: [0.15, 0.55] },
            { focus: ['[role="timer"]'], pad: { phone: 40, desktop: 60 }, band: [0.15, 0.55] },
          ],
        },
        act: async (page, info) => {
          const m = marks(page, info);
          const score = m.at(200, tag(".bp-score-n", "Score", "right", { gap: 18 }), 3000);
          if (page.__move) await bpPlace(page, page.__move);
          for (let n = 0; n < 2; n++) {
            const move = bpBest(await bpRead(page));
            if (!move) break;
            await bpPlace(page, move);
          }
          await score;
          await info.cam.to(1, 0.8);
          await sleep(500);
          await m.show(tag('[role="timer"]', "Clock", "right", { gap: 18 }), 2200);
        },
      },
      // the game's own ending: play on until the clock runs out, then the final score
      5: {
        prep: async (page) => {
          await bpWaitPlaying(page);
          const start = Date.now();
          while (Date.now() - start < 110000) {
            const left = await page.evaluate(() => document.querySelector('[role="timer"] .mono, [role="timer"]')?.textContent?.match(/(\d+):(\d+)/)?.slice(1).map(Number) ?? null);
            if (!left || left[0] * 60 + left[1] <= 9) break;
            if (await page.locator(".bp-overlay").count()) throw new Error("the game ended before the last seconds");
            const move = bpBest(await bpRead(page));
            if (!move) break;
            await bpPlace(page, move);
          }
        },
        focus: [".bp-score-n", '[role="timer"]', ".bp-board .bp-cell:nth-child(-n+8)"],
        pad: { phone: 12, desktop: 20 },
        // the Time's up dialog blurs the board behind it: render lighter so the GPU keeps 60 fps
        dsf: { phone: 1, desktop: 1 },
        act: async (page, info) => {
          let placed = 0;
          const start = Date.now();
          while (!(await page.locator(".bp-overlay").count()) && Date.now() - start < 20000) {
            const move = placed < 2 ? bpBest(await bpRead(page)) : null;
            if (move) { await bpPlace(page, move); placed++; }
            else await sleep(300);
          }
          await page.waitForSelector(".bp-overlay", { timeout: 5000 });
          await info.look([".bp-final"], { phone: 60, desktop: 120 }, 0.8);
          await sleep(3200);
        },
      },
    },
  },
  holdem: {
    focus: [".hdx-pot", ".hdx-board", ".hd-cards|last"],
    steps: {
      // both stacks: the camera goes from the Bot's down to yours
      1: {
        prep: () => sleep(500),
        focus: { phone: [".hd-plaque-text|first"], desktop: [".hd-cards|first", ".hd-plaque-text|first"] },
        pad: { phone: 100, desktop: 40 },
        camera: {
          keys: [
            { focus: { phone: [".hd-plaque-text|first"], desktop: [".hd-cards|first", ".hd-plaque-text|first"] }, pad: { phone: 100, desktop: 40 }, sec: 1.0 },
            { focus: { phone: [".hd-plaque-text|last"], desktop: [".hd-cards|last", ".hd-plaque-text|last"] }, pad: { phone: 100, desktop: 40 }, sec: 6.0 },
          ],
        },
        act: async (page, info) => {
          const m = marks(page, info);
          const b = m.at(4600, tag(".hd-stack|last", "Your stack", info.set === "desktop" ? "right" : "below", { gap: info.set === "desktop" ? 16 : 4 }), 2400);
          await sleep(7000);
          await b;
        },
      },
      // your two cards, then the shared cards dealt after you call; the Bot's two stay face down
      2: {
        prep: (page) => hdWaitMyTurn(page),
        pad: { phone: 20, desktop: 40 },
        camera: {
          cues: [
            { focus: { phone: [".hdx-board", ".hd-cards|last", ".hdx-pot"], desktop: [".hd-cards|last", ".hd-plaque-text|last"] }, pad: { phone: 20, desktop: 40 } },
            { focus: { phone: [".hdx-board", ".hd-cards|last", ".hdx-pot"], desktop: [".hdx-board", ".hdx-pot"] }, pad: { phone: 20, desktop: 60 } },
          ],
        },
        act: async (page, info) => {
          const m = marks(page, info);
          const mine = m.at(300, tag(".hd-cards|last", "Your cards", "above", { ring: "rect", pad: 5, gap: 14 }), 3200);
          const start = Date.now();
          while ((await hdBoardCards(page)) < 3 && Date.now() - start < 14000) {
            const pass = page.locator(".hdx-btn", { hasText: /^(Call|Check)/ });
            if (await pass.isEnabled().catch(() => false)) { await sleep(1100); await pass.click().catch(() => {}); }
            await sleep(400);
          }
          await info.cam.to(1, 0.8);
          const shared = m.at(900, tag(".hdx-board", "Shared cards", "above", { ring: "rect", pad: 5, gap: 14 }), 2400);
          await sleep(3800);
          await Promise.all([mine, shared]);
        },
      },
      // the four actions: pick two raise sizes, then call
      3: {
        prep: (page) => hdWaitMyTurn(page),
        focus: { phone: [".hdx-actions"], desktop: [".hdx-btn"] },
        pad: { phone: 60, desktop: 50 },
        act: async (page, info) => {
          const m = marks(page, info);
          const clock = m.at(200, tag(".hdx-actions", "30 s to act", "above", { ring: "rect", pad: 4, gap: 6 }), 1900);
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
        focus: { phone: [".hdx-pot", ".hdx-board", ".hd-cards|last"], desktop: [".hdx-board", ".hd-cards|last"] },
        pad: { phone: 20, desktop: 30 },
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
      // the game's own ending: all-in on a fresh hand; the Bot calls, loses, and its stack goes to zero (a take where you lose is thrown away)
      5: {
        prep: (page) => hdWaitMyTurn(page),
        reseed: true,
        tries: 10,
        focus: { phone: [".hd-cards|last", ".hd-plaque-text|last"], desktop: [".hd-cards|last", ".hd-plaque-text|last"] },
        pad: { phone: 40, desktop: 40 },
        camera: {
          cues: [
            { focus: [".hd-cards|last", ".hd-plaque-text|last"], pad: { phone: 40, desktop: 40 } },
            { focus: [".hd-cards|first", ".hd-plaque-text|first"], pad: { phone: 40, desktop: 40 } },
          ],
        },
        maxSecs: 22,
        act: async (page, info) => {
          await page.locator(".hd-preset", { hasText: "All-in" }).first().click({ timeout: 3000 });
          await sleep(900);
          await page.locator(".hdx-btn").nth(2).click({ timeout: 3000 });
          const start = Date.now();
          while (!(await page.locator('[aria-label="Match over"]').count()) && Date.now() - start < 30000) {
            const pass = page.locator(".hdx-btn", { hasText: /^(Call|Check)/ });
            if (await pass.isEnabled().catch(() => false)) await pass.click().catch(() => {});
            await sleep(300);
          }
          if (!(await page.locator('[aria-label="Match over"]').count())) return false;
          const text = await page.locator('[aria-label="Match over"]').innerText();
          if (!/You won/i.test(text)) { console.log("  holdem/5: the Bot won this hand, trying another"); return false; }
          console.log(`  holdem/5 ending: ${text.replace(/\s+/g, " ").slice(0, 100)}`);
          await info.cam.to(1, 0.8);
          await sleep(1800);
          await page.waitForFunction(() => { const e = document.querySelector(".hdx-end"); return e && Number(getComputedStyle(e).opacity) > 0.95 && e.getBoundingClientRect().width > 100; }, null, { timeout: 20000, polling: 100 });
          await sleep(300);
          await info.look([".hd-practice-end"], { phone: 40, desktop: 60 }, 0.8);
          await sleep(3400);
        },
      },
    },
  },
  "trading-duel": {
    focus: [".tg-head-dot"],
    steps: {
      // the head start clock, then the live price line with its trail drawn behind the dot
      1: {
        prep: async (page) => { await tdWaitStart(page); await tdUntil(page, 26); },
        focus: { phone: [".tg-strip-clock", ".tg-head-dot"], desktop: [".tg-head-dot"] },
        pad: { phone: 20, desktop: 90 },
        camera: {
          keys: [
            { focus: { phone: [".tg-strip-clock", ".tg-head-dot"], desktop: [".tg-head-dot"] }, pad: { phone: 20, desktop: 90 }, sec: 0 },
            { focus: { phone: [".tg-strip-clock", ".tg-head-dot"], desktop: [".tg-head-dot"] }, pad: { phone: 20, desktop: 90 }, sec: 2.4 },
            { focus: [".tg-head-dot"], pad: { phone: 100, desktop: 90 }, sec: 3.4 },
          ],
        },
        act: async (page, info) => {
          console.log(`  td1: clock at the start of the take: ${await tdClock(page)} s`);
          const m = marks(page, info);
          const a = m.at(300, { kind: "label", target: ".tg-strip-clock", text: "Head start", side: "below", gap: 10 }, 2200);
          const b = m.at(3600, tag(".tg-head-dot", "Live price", "above", { ring: "circle", pad: 10, gap: 14 }), 3600);
          await sleep(8000);
          await Promise.all([a, b]);
        },
      },
      // tap one box in each column (the row the line starts in, so the boxes sit beside the line)
      2: {
        prep: tdWaitStart,
        pad: { phone: 130, desktop: 90 },
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
          await info.look([".tg-head-dot", '[data-htp="pick2"]'], { phone: 130, desktop: 60 }, 0.8);
          await sleep(1400);
          for (const id of rings) await m.remove(id);
          await sleep(250);
        },
      },
      // a column locks: the picks turn into locked chips
      3: {
        prep: async (page) => { await tdWaitStart(page); await tdMark(page, 0, 0, "pick0"); await tdPick(page, 0, 0); await tdUntil(page, 13); },
        focus: { phone: [".tg-head-dot"], desktop: [".tg-head-dot", '[data-htp="pick0"]'] },
        pad: { phone: 130, desktop: 60 },
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
        pad: { phone: 150, desktop: 110 },
        camera: {
          keys: [
            { focus: ['[data-htp="pick"]'], pad: { phone: 150, desktop: 110 }, sec: 7.7 },
            { focus: { phone: [".tg-scoreboard-in"], desktop: [".tg-score|first"] }, pad: { phone: 100, desktop: 110 }, sec: 10.5 },
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
      // the game's own ending: pick through the game on the bands the line spends most time in, then the last column locks and the final scores show (a take that loses is thrown away)
      5: {
        prep: async (page, { seed }) => {
          await tdWaitStart(page);
          let next = 0;
          while ((await tdClock(page)) < 137) {
            const now = (await tdClock(page)) ?? 0;
            if (next < 12 && now >= next * 10 - 5) { const band = await tdBestBand(next, seed); const ok = await tdPick(page, next, band, { far: true }).catch((e) => e.message.slice(0, 60)); console.log(`  td5 pick col ${next} band ${band} at ${now}s: ${ok}`); next++; }
            await sleep(400);
          }
        },
        reseed: true,
        tries: 5,
        focus: { phone: [".tg-scoreboard-in", ".tg-head-dot"], desktop: [".tg-head-dot"] },
        pad: { phone: 20, desktop: 120 },
        maxSecs: 16,
        act: async (page, info) => {
          const start = Date.now();
          while (!(await page.locator('[aria-label="Game over"]').count()) && Date.now() - start < 40000) await sleep(300);
          if (!(await page.locator('[aria-label="Game over"]').count())) return false;
          console.log("  td5 end: " + (await page.locator('[aria-label="Game over"]').innerText()).replace(/\s+/g, " "));
          if (!/You won/i.test(await page.locator('[aria-label="Game over"]').innerText())) { console.log("  trading-duel/5: not a win, trying another seed"); return false; }
          await info.look([".tg-end-panel"], { phone: 30, desktop: 40 }, 0.8);
          await sleep(3500);
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
            { focus: [".vg-piece.us"], pad: { phone: 20, desktop: 10 }, sec: 1.6 },
            { focus: [".vg-piece.it"], pad: { phone: 20, desktop: 10 }, sec: 6.8 },
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
            { focus: [".vg-plate.us .vg-ava"], pad: { phone: 60, desktop: 140 }, sec: 3.3 },
            { focus: [".vg-piece.us", ".vg-plate.us"], pad: { phone: 30, desktop: 60 }, sec: 4.5 },
            { focus: [".vg-piece.us", ".vg-plate.us"], pad: { phone: 30, desktop: 60 }, sec: 5.6 },
            { focus: [".vg-board"], pad: 0, band: VG_WHOLE_BOARD, sec: 7.2 },
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
          const mine1 = mine ? `Your ${mine}` : "Your piece";
          // close on your attacker, name it, draw the move
          await info.cam.to(1, 0.6);
          await sleep(700);
          const ids = await Promise.all(tag(".vg-piece.us.sel", mine1, "above", { gap: 4 }).map((x) => m.add(x)));
          await sleep(1300);
          const arrow = await m.add({ kind: "arrow", target: ".vg-piece.us.sel", to: spot });
          await sleep(700);
          const ranks = () => page.evaluate(() => [...document.querySelectorAll(".vg-piece.it")].map((e) => e.getAttribute("aria-label")?.match(/^Italian (\d+|B|F) /)?.[1] ?? null));
          const before = await ranks();
          await info.cam.to(2, 0.45);
          await sleep(350);
          await page.__win.click({ force: true, timeout: 1500 }).catch(() => {});
          await m.remove(arrow);
          for (const id of ids) await m.remove(id);
          // the clash: the camera is on the target square; the piece it hit turns face up, and its rank is named while it shows
          let lost = null;
          for (let i = 0; i < 20 && !lost; i++) {
            const now = await ranks();
            lost = now.find((r, k) => r && r !== before[k]) ?? null;
            if (!lost) await sleep(50);
          }
          await m.show({ kind: "label", target: spot, text: lost ? `${lost} revealed` : "Lower rank", side: "above", gap: 4 }, 1400);
          await m.show({ kind: "label", target: spot, text: mine ? `${mine} wins` : "You win", side: "below", gap: 4 }, 1400);
          await info.cam.to(0, 0.8);
          await sleep(900);
          return (await vgEnemies(page)).length === enemies - 1;
        },
        // wide, then in on the attacker (a piece is a quarter of the frame), then on the target square for the clash, then out
        focus: [".vg-piece.us.sel", ".vg-mark.atk"],
        pad: { phone: 95, desktop: 190 },
        camera: {
          cues: [
            { focus: [".vg-piece.us.sel", ".vg-mark.atk"], pad: { phone: 95, desktop: 190 } },
            { focus: [".vg-piece.us.sel"], pad: { phone: 33, desktop: 8 } },
            { focus: [".vg-mark.atk"], pad: { phone: 33, desktop: 8 } },
          ],
        },
        speed: 1,
        reseed: true,
        poster: 0.5,
      },
      // an Engineer walks up until enemy coins touch it; tapped, its preview squares show; the view drops to its Blast button, presses it, and returns
      4: {
        prep: async (page) => { page.__eng = await vgUntilBlast(page); if (page.__eng === null) throw new Error("no Engineer reached the enemy"); },
        focus: ['[data-htp="eng"]'],
        pad: { phone: 33, desktop: 8 },
        camera: {
          cues: [
            { focus: ['[data-htp="eng"]'], pad: { phone: 33, desktop: 30 }, dx: { desktop: -130 } },
            { focus: [".vg-plate.us", ".vg-power"], pad: { phone: 40, desktop: 60 } },
          ],
        },
        act: async (page, info) => {
          const m = marks(page, info);
          await vgTap(page, page.__eng);
          const engLabel = await m.add({ kind: "label", target: '[data-htp="eng"]', text: "Select a piece", side: info.set === "desktop" ? "left" : "above", gap: info.set === "desktop" ? 14 : 4 });
          await sleep(1900);
          await m.remove(engLabel);
          await info.cam.to(1, 0.7);
          await sleep(900);
          const power = await m.add({ kind: "ring", target: ".vg-power", pad: 8 });
          const powerLabel = await m.add({ kind: "label", target: ".vg-power", text: "Its power", side: "above", gap: 10 });
          await sleep(1700);
          await page.locator(".vg-power").first().click({ force: true, timeout: 1500 });
          await m.remove(power);
          await m.remove(powerLabel);
          await info.cam.to(0, 0.6);
          await sleep(800);
          const eb = await page.locator('[data-htp="eng"]').boundingBox().catch(() => null);
          const area = eb ? { x: eb.x - eb.width, y: eb.y - eb.height, w: eb.width * 3, h: eb.height * 3 } : '[data-htp="eng"]';
          await m.show({ kind: "label", target: area, text: "Revealed", side: "below", gap: -8 }, 2400);
          await sleep(900);
        },
        reseed: true,
        poster: 0.75,
      },
      // a Recon runs across the board and takes the Supply Truck (planned from the seeded setup); then the real result screen
      5: {
        prep: async (page, { seed }) => { if (!(await vgCaptureTruck(page, seed, 2))) throw new Error("no Recon route to the Truck"); },
        focus: ['[data-htp]'],
        pad: { phone: 40, desktop: 80 },
        maxSecs: 16,
        camera: {
          cues: [
            { focus: ['[data-htp="a"]'], pad: { phone: 33, desktop: 8 } },
            { focus: ['[data-htp="b"]'], pad: { phone: 33, desktop: 8 } },
            { focus: ['[data-htp]'], pad: { phone: 40, desktop: 80 } },
          ],
        },
        // seed 41 deals a Recon with a clear straight run to the Truck (found by search over the seeded setups)
        seed: 41,
        act: async (page, info) => vgCaptureTruck(page, info.seed, 0, marks(page, info), info.cam, info.look),
        poster: 0.85,
      },
    },
  },
};

// ---------------------------------------------------------------- recorder

const only = (process.env.ONLY ?? "").split(",").filter(Boolean).map((s) => s.split(":"));
const wanted = (game, step) => !only.length || only.some(([g, n]) => g === game && (n === undefined || Number(n) === step));
const sets = (process.env.SETS ?? "phone,desktop").split(",");

// The scripted drags selected the page's text: the gray rectangles behind the score, the clock and the PRACTICE pill were selection highlights.
const HIDE_DEV_UI = "nextjs-portal, [data-nextjs-toast], [data-next-badge-root] { display: none !important; } * { -webkit-user-select: none !important; user-select: none !important; }";
const WFR = process.env.WFR ?? "wf-recorder";

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
    return u && window.__htp ? window.__htp.unproject(u) : u;
  }, focus);
  if (!box) throw new Error(`focus not found: ${focus.join(", ")}`);
  return box;
}

/**
 * The view rect (unzoomed page px): the union of `focus`, padded, then sized to the set's aspect ratio so that it fits the clear band
 * of the clip, and centred on the band's middle (not the frame's). It stays inside the viewport sideways; it may reach EDGE px past
 * the page's top or bottom (the page background fills that).
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

const forSet = (v, name) => (v && !Array.isArray(v) && (v.phone || v.desktop) ? v[name] : v);

/** The part of the screen the clip is cut from, in CSS px: the top 4:5 of a phone screen, the whole desktop screen. */
const cropOf = (set) => ({ x: 0, y: 0, w: set.context.viewport.width, h: set.context.viewport.width / set.ratio });

/** The screen encoder: the GPU's H.264 when there is one (the CPU is busy rendering the page), else x264 ultrafast. */
const ENCODER = process.env.HTP_ENCODER ?? "x264";
const startRecorder = (file) => {
  const enc = ENCODER === "vaapi" ? ["-c", "h264_vaapi", "-d", "/dev/dri/renderD128", "-p", "qp=16"] : ["-c", "libx264", "-p", "crf=16", "-p", "preset=ultrafast"];
  const proc = spawn(WFR, ["-o", OUTPUT, "-D", "-r", "60", ...enc, "-f", file, "-y"], { env: screenEnv(), stdio: ["ignore", "ignore", "pipe"] });
  const done = new Promise((ok) => proc.on("exit", ok));
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  return { proc, done, err: () => err };
};

/** One take: bring the game to the moment (unrecorded), cover the screen, start recording, uncover, play, cover, stop. */
async function record(page, game, step, setName, attempt, work) {
  const set = SETS[setName];
  const def = GAMES[game].steps[step];
  const seed = def.seed ?? SEED + (def.reseed ? attempt : 0);
  page.on("pageerror", (e) => console.log(`  ${game}:${step}:${setName} pageerror: ${e.message}`));
  await page.goto(`${BASE}${def.route ?? `/play/practice?game=${game}&dev=demo&seed=${seed}`}`, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({ content: HIDE_DEV_UI });
  await sleep(2000);
  // a lighter device scale factor for clips whose game draws heavy effects (blurred dialogs): the GPU keeps 60 fps, and the clip is
  // only 480 or 960 px wide anyway. The window stays the same size; only its top-left part is drawn.
  const dsf = def.dsf?.[setName] ?? SCREENS[setName].dsf;
  const sc = SCREENS[setName];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: sc.css[0], height: sc.css[1], deviceScaleFactor: dsf, mobile: false });
  await sleep(400);
  const C = cropOf(set);
  await page.evaluate((c) => window.__htp.init(c), { C, out: set.out, band: set.band });
  const info = { seed, set: setName };
  await def.prep?.(page, info);

  // the camera: rects (unzoomed page px) for the start, the keys and the cues
  const focus = def.focus ?? GAMES[game].focus;
  const first = await cropFor(page, forSet(def.camera?.cues?.[0]?.focus ?? def.camera?.keys?.[0]?.focus ?? focus, setName), set, (def.camera?.cues?.[0] ?? def.camera?.keys?.[0] ?? def).pad?.[setName] ?? (def.camera?.cues?.[0] ?? def.camera?.keys?.[0] ?? def).pad, (def.camera?.cues?.[0] ?? def.camera?.keys?.[0])?.band?.[setName] ?? undefined);
  const rectFor = async (k) => {
    const pad = k.pad?.[setName] ?? k.pad;
    const r = await cropFor(page, forSet(k.focus, setName), set, typeof pad === "number" ? pad : undefined, Array.isArray(k.band) ? k.band : k.band?.[setName]);
    // `dx` moves the crop sideways (CSS px), to keep the action centred when it sits against the edge of the page's content
    const dx = typeof k.dx === "number" ? k.dx : k.dx?.[setName] ?? 0;
    return { ...r, x: r.x + dx };
  };
  const cues = def.camera?.cues ? await Promise.all(def.camera.cues.map(rectFor)) : null;
  const keys = def.camera?.keys ? await Promise.all(def.camera.keys.map(async (k) => ({ sec: k.sec, rect: await rectFor(k) }))) : null;
  const start = cues?.[0] ?? keys?.[0]?.rect ?? first;
  if (cues) {
    info.cam = { to: (i, dur = 0.7) => page.evaluate(([r, d]) => window.__htp.camera.go(r, d), [cues[i], dur]) };
  }
  // look at something that only exists later (a dialog): the crop is planned now, from where it is now
  info.look = async (focusSpec, pad, dur = 0.7) => {
    const r = await cropFor(page, forSet(focusSpec, setName), set, pad?.[setName] ?? pad);
    await page.evaluate(([rect, d]) => window.__htp.camera.go(rect, d), [r, dur]);
  };

  // record: cover (a magenta screen marks the start and the end of the take in the video), start, uncover
  await page.evaluate((r) => { window.__htp.camera.set(r); window.__htp.cover(true); }, start);
  await sleep(400);
  const vfr = join(work, `${game}-${step}-${setName}-${attempt}.mp4`);
  const rec = startRecorder(vfr);
  await sleep(1200);
  await page.evaluate(() => { window.__htp.frames(true); window.__htp.cover(false); });
  const timers = [];
  if (keys) {
    keys.slice(0, -1).forEach((k, i) => {
      if (JSON.stringify(k.rect) === JSON.stringify(keys[i + 1].rect)) return;
      timers.push(setTimeout(() => page.evaluate(([r, d]) => window.__htp.camera.go(r, d), [keys[i + 1].rect, keys[i + 1].sec - k.sec]).catch(() => {}), k.sec * 1000));
    });
  }
  const ok = await def.act(page, info);
  await sleep(def.tail ?? 400);
  timers.forEach(clearTimeout);
  const gaps = await page.evaluate(() => window.__htp.frames());
  const slow = gaps.filter((g) => g > 25).length;
  console.log(`  ${game}/${step}-${setName}: browser frames ${gaps.length + 1}, over 25 ms: ${slow}, worst ${Math.max(...gaps).toFixed(0)} ms`);
  await page.evaluate(() => { window.__htp.clear(); window.__htp.cover(true); });
  await sleep(500);
  rec.proc.kill("SIGINT");
  await rec.done;
  if (!existsSync(vfr)) throw new Error(`wf-recorder wrote nothing: ${rec.err().slice(0, 200)}`);
  return { ok: ok !== false, vfr, dsf };
}

/** Frame numbers (at 60 fps) where the take starts and ends: the first frame that is not the magenta cover, and the next magenta one. */
async function takeRange(vfr, set, dsf) {
  const C = cropOf(set);
  const { stdout } = await promisify(execFile)(FFMPEG, ["-v", "error", "-i", vfr, "-vf", `fps=60,crop=${even(C.w * dsf)}:${even(C.h * dsf)}:0:0,scale=4:4:flags=area,format=rgb24`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 28 });
  const size = 4 * 4 * 3;
  const n = Math.floor(stdout.length / size);
  const magenta = (f) => {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < 16; i++) { r += stdout[f * size + i * 3]; g += stdout[f * size + i * 3 + 1]; b += stdout[f * size + i * 3 + 2]; }
    return r / 16 > 200 && g / 16 < 70 && b / 16 > 200;
  };
  let a = 0;
  while (a < n && magenta(a)) a++;
  let b = a;
  while (b < n && !magenta(b)) b++;
  if (a >= n || b - a < 60) throw new Error(`no take found in the screen recording (frames ${a}..${b} of ${n})`);
  return { a, b, n };
}

/** JPEG-free: the screen recording is limited-range yuv420p from swscale (BT.601 matrix); the clip is limited-range BT.709, the only kind every browser plays. */
const LIMITED = "scale=in_range=tv:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p";
const COLOUR_TAGS = ["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

/** Frames per second of a video that differ from the frame before them (decoded frames compared, so a repeated frame is not counted). */
async function uniqueFps(file) {
  const r = await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", file, "-an", "-f", "framemd5", "-"]);
  const sums = r.stdout.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim());
  const changed = sums.filter((m, i) => i > 0 && m !== sums[i - 1]).length;
  return changed / (sums.length / 60);
}

/** The colour format browsers decode: yuv420p, limited range. Anything else fails to play in a normal browser. */
async function assertPlayable(file) {
  const out = await run(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,color_range", "-of", "csv=p=0", file]);
  const [pix, range] = out.stdout.trim().split(",");
  if (pix !== "yuv420p" || range !== "tv") {
    throw new Error(`${file} is ${pix}/${range}, not yuv420p/tv: browsers cannot decode full-range video (fix the colour conversion in LIMITED and the encoder tags)`);
  }
}

/** Every video written this run, played in the recording Chromium (headed, on the hidden screen): currentTime must pass 1 s within 5 s with no error. */
async function playbackCheck(page, files) {
  const failures = [];
  for (const file of files) {
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
  }
  return failures;
}

const written = [];

async function encode(game, step, setName, take) {
  const set = SETS[setName];
  const def = GAMES[game].steps[step];
  const dsf = SCREENS[setName].dsf; // the screen's pixels per CSS px (an emulated lower scale factor is stretched to fill the same window)
  const [ow, oh] = set.out;
  const dest = join(OUT, game);
  mkdirSync(dest, { recursive: true });
  const base = join(dest, `${step}-${setName}`);
  const { a, b } = await takeRange(take.vfr, set, dsf);

  const real = (b - a) / 60;
  const speed = Math.max(def.speed ?? 1, real / (def.maxSecs ?? MAX_SECS));
  const secs = real / speed;
  const C = cropOf(set);
  const cropPx = `crop=${even(C.w * dsf)}:${even(C.h * dsf)}:0:0`;
  const fade = `fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, secs - 0.3).toFixed(2)}:d=0.25`;
  const vf = `fps=60,trim=start_frame=${a}:end_frame=${b},setpts=(PTS-STARTPTS)/${speed.toFixed(4)},fps=60,${cropPx},scale=${ow}:${oh}:flags=lanczos,${fade},${LIMITED}`;
  const input = ["-y", "-loglevel", "error", "-i", take.vfr, "-vf", vf, "-r", "60", "-an", "-pix_fmt", "yuv420p", ...COLOUR_TAGS];
  const sizes = {};
  for (const [ext, codec, crfs] of [
    ["webm", (crf) => ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(crf), "-row-mt", "1", "-deadline", "good", "-cpu-used", "2"], [34, 38, 42, 46, 50, 54, 58, 62]],
    ["mp4", (crf) => ["-c:v", "libx264", "-crf", String(crf), "-preset", "slow", "-movflags", "+faststart"], [24, 27, 30, 33, 37, 41, 45]],
  ]) {
    for (const crf of crfs) {
      await run(FFMPEG, [...input, ...codec(crf), `${base}.${ext}`]);
      sizes[ext] = Math.round(statSync(`${base}.${ext}`).size / 1024);
      if (sizes[ext] <= MAX_KB) break;
    }
  }
  // the poster: a frame from the clip (fraction `poster` of the way through)
  const at = (a + (b - a) * (def.poster ?? 0.6)) / 60;
  await run(FFMPEG, ["-y", "-loglevel", "error", "-ss", at.toFixed(3), "-i", take.vfr, "-vf", `${cropPx},scale=${ow}:${oh}:flags=lanczos,scale=in_range=tv:out_range=tv,format=yuv420p`, "-frames:v", "1", "-c:v", "libwebp", "-quality", "82", `${base}.webp`]);

  for (const ext of ["webm", "mp4"]) await assertPlayable(`${base}.${ext}`);
  written.push(`${base}.webm`, `${base}.mp4`);
  const fps = await uniqueFps(`${base}.mp4`);
  const smooth = await frameDiffs(`${base}.mp4`).then(continuity);
  const warn = secs < MIN_SECS ? "  (SHORT)" : sizes.webm > MAX_KB || sizes.mp4 > MAX_KB ? "  (OVER SIZE)" : "";
  console.log(`${game}/${step}-${setName}: ${ow}x${oh}, ${secs.toFixed(1)} s (x${speed.toFixed(2)}), webm ${sizes.webm} KB, mp4 ${sizes.mp4} KB, ${fps.toFixed(1)} unique fps, still-in-motion ${(smooth.share * 100).toFixed(1)}%${warn}`);
  if (fps < MIN_FPS) throw new Error(`only ${fps.toFixed(1)} unique frames per second (needs ${MIN_FPS}): the screen barely moves in this take (add motion, a camera move or a longer act)`);
  if (smooth.share >= MAX_SHARE) {
    throw new Error(`${(smooth.share * 100).toFixed(0)}% of the frame pairs inside movements are still: animations teleport (the machine was too busy to render 60 fps: close other work, or lower the encoder load)`);
  }
}

const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "htp-"));
let failed = 0;
for (const setName of sets) {
  const screen = await screenUp(setName);
  try {
    if (process.env.HTP_NO_WILLCHANGE) await screen.ctx.addInitScript(() => { window.__htpNoWillChange = true; });
    await screen.ctx.addInitScript(OVERLAY_JS);
    // Mark every Game's first-Practice guide as seen, so the recording shows the game, not the guide.
    await screen.ctx.addInitScript(() => {
      for (const g of ["block-puzzle", "holdem", "trading-duel", "vanguard"]) localStorage.setItem(`tesoro:how-to-play:${g}`, "1");
    });
    for (const game of Object.keys(GAMES)) {
      for (const step of [1, 2, 3, 4, 5]) {
        if (!wanted(game, step)) continue;
        const tries = GAMES[game].steps[step].tries ?? 3;
        let done = false;
        for (let attempt = 0; attempt < tries && !done; attempt++) {
          let take = null;
          try {
            take = await record(screen.page, game, step, setName, attempt, work);
            if (!take.ok) { console.log(`${game}/${step}-${setName}: take ${attempt} discarded`); continue; }
            await encode(game, step, setName, take);
            done = true;
          } catch (e) {
            console.log(`${game}/${step}-${setName}: take ${attempt} failed: ${e.message.split("\n")[0]}`);
          } finally {
            if (take?.vfr && !process.env.KEEP) rmSync(take.vfr, { force: true });
          }
        }
        if (!done) { failed++; console.log(`${game}/${step}-${setName}: NO CLIP`); }
      }
    }
    const unplayable = process.env.NO_PLAYBACK_CHECK ? [] : await playbackCheck(screen.page, written.filter((f) => f.includes(`-${setName}.`)));
    console.log(`playback check (${setName}, headed Chromium): ${written.filter((f) => f.includes(`-${setName}.`)).length - unplayable.length}/${written.filter((f) => f.includes(`-${setName}.`)).length} videos play`);
    for (const f of unplayable) console.log(`  DOES NOT PLAY ${f}`);
    failed += unplayable.length;
  } finally {
    await screenDown();
  }
}
if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
if (failed) process.exit(1);
