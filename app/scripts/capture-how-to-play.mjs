/**
 * Records the "How to play" guide clips from the real Practice screens (dev fixtures, no chain):
 * public/art/how-to-play/<game>/<n>-<phone|desktop>.{webm,mp4,webp}, for every step of the four Games.
 * Phone set: 390 px wide phone layout, cropped to portrait 4:5. Desktop set: 1440x900 desktop layout, cropped to 16:10.
 * Both sets play the same script. Re-run whenever a game's UI or the step list changes:
 *
 *   NEXT_PUBLIC_DEV_WALLET=1 pnpm --filter @tesoro/app dev            # dev server, e.g. on port 3141
 *   BASE=http://localhost:3141 node scripts/capture-how-to-play.mjs
 *
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
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.env.OUT ?? join(HERE, "../public/art/how-to-play"));
const BASE = process.env.BASE ?? "http://localhost:3141";
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const MIN_SECS = 3;
const MAX_SECS = 8;
const MAX_KB = 300;
const SEED = 3;

const SETS = {
  phone: { context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, ratio: 4 / 5, out: [480, 600], pad: 8 },
  desktop: { context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, ratio: 16 / 10, out: [960, 600], pad: 12 },
};

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const even = (n) => Math.round(n / 2) * 2;

// ---------------------------------------------------------------- shared page helpers

/** Centre of the first element matching `selector` that is on screen. */
async function centre(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

/** Drags with the mouse from one point to another in small steps, like a finger. */
async function drag(page, from, to, steps = 14) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + (to.x - from.x) * 0.15, from.y + (to.y - from.y) * 0.15, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps });
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
async function bpPlace(page, move) {
  const slot = page.locator(".bp-slot").nth(move.piece.i);
  const from = await centre(page, `.bp-slot:nth-child(${move.piece.i + 1})`) ?? (await slot.boundingBox().then((b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })));
  const first = await page.locator(".bp-board .bp-cell").nth(move.y * 8 + move.x).boundingBox();
  const last = await page.locator(".bp-board .bp-cell").nth((move.y + move.h - 1) * 8 + move.x + move.w - 1).boundingBox();
  const to = { x: (first.x + last.x + last.width) / 2, y: (first.y + last.y + last.height) / 2 };
  await drag(page, from, to);
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
    // build up along the top rows so the clear happens high in the frame, clear of the caption
    const next = bpBest(state, true);
    await bpPlace(page, next ?? move);
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
async function tdPick(page, c, k) {
  const cell = await page.evaluateHandle(([col, band]) => {
    const dot = document.querySelector(".tg-head-dot");
    return dot ? [...document.querySelectorAll(`.tg-cell[data-cell^="${col}_"]`)].find((e) => e.dataset.cell === `${col}_${band}`) : null;
  }, [c, k]);
  const box = await cell.asElement()?.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return !!box;
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

const GAMES = {
  "block-puzzle": {
    focus: [".bp-board", ".bp-slot"],
    steps: {
      // the real Match screen on a fixed Seed: both Players get the same pieces at the same time
      1: {
        route: "/design/play?dev=demo",
        focus: [".bpx-status", ".bp-slot"],
        prep: (page) => page.waitForSelector(".bp-board"),
        act: async () => { await sleep(5500); },
      },
      2: {
        prep: bpWaitPlaying,
        act: async (page) => {
          for (let n = 0; n < 3; n++) {
            const move = bpBest(await bpRead(page));
            if (!move) break;
            await bpPlace(page, move);
          }
        },
      },
      3: {
        prep: async (page) => { await bpWaitPlaying(page); page.__move = await bpUntilClear(page); },
        act: async (page) => {
          if (!page.__move) return false;
          await bpPlace(page, page.__move);
          await sleep(1800);
        },
        poster: 0.7,
      },
      // Practice has no opponent: the closest real screen is your own score and the clock while you play
      4: {
        prep: bpWaitPlaying,
        act: async (page) => {
          for (let n = 0; n < 4; n++) {
            const move = bpBest(await bpRead(page), true);
            if (!move) break;
            await bpPlace(page, move);
          }
        },
        focus: [".bp-board", ".bp-slot", '[role="timer"]', ".bp-score-n"],
      },
      // the Match result screen on fixtures: the higher score takes the Pot minus Fees
      5: {
        route: "/design/result?case=won&dev=demo",
        focus: ["main", ".match-result"],
        prep: () => sleep(1500),
        act: async () => { await sleep(5000); },
      },
    },
  },
  holdem: {
    // both seats, the pot and the community cards
    focus: [".hd-plaque-text", ".hd-cards", ".hdx-pot", ".hdx-board"],
    steps: {
      1: { prep: () => sleep(500), focus: [".hd-plaque-text", ".hdx-pot", ".hdx-board"], act: async () => { await sleep(5500); } },
      2: {
        prep: () => sleep(500),
        focus: [".hd-cards", ".hd-plaque-text|last", ".hdx-board", ".hdx-actions"],
        act: async (page) => {
          const pass = await hdWaitMyTurn(page);
          await sleep(1500);
          await pass.click();
          await waitFor(page, () => document.querySelectorAll(".hdx-board .hd-card:not(.empty)").length >= 3, 20000).catch(() => {});
          await sleep(2200);
        },
        speed: 1.3,
      },
      3: { prep: (page) => hdWaitMyTurn(page), focus: [".hdx-actions", ".hd-plaque-text|last", ".hdx-board"], act: async () => { await sleep(5000); } },
      4: {
        focus: [".hd-plaque-text", ".hd-cards", ".hdx-board", ".hdx-actions"],
        prep: (page) => hdUntilBoard(page, 4),
        act: async (page) => {
          const start = Date.now();
          while (Date.now() - start < 22000) {
            const pass = page.locator(".hdx-btn", { hasText: /^(Call|Check)/ });
            if (await pass.isEnabled().catch(() => false)) { await sleep(600); await pass.click().catch(() => {}); }
            const won = await page.getByText(/wins? [\d,]+ Chips/).evaluateAll((els) => els.some((e) => e.getBoundingClientRect().width > 100)).catch(() => false);
            if (won) break;
            await sleep(400);
          }
          await sleep(3500);
        },
      },
      // the Match result screen on fixtures (a Practice game has no Pot)
      5: { route: "/design/result?case=holdem-won&dev=demo", focus: ["main", ".match-result"], prep: () => sleep(1500), act: async () => { await sleep(5000); } },
    },
  },
  "trading-duel": {
    focus: [".tg-stage"],
    steps: {
      1: { prep: tdWaitStart, act: async () => { await sleep(7000); } },
      2: {
        prep: tdWaitStart,
        act: async (page, { seed }) => {
          for (const [c, at] of [[0, 35], [1, 45], [2, 55]]) { await tdPickAt(page, c, at, seed); await sleep(1600); }
          await sleep(1200);
        },
      },
      3: {
        prep: async (page, { seed }) => { await tdWaitStart(page); await tdPickAt(page, 0, 35, seed); await tdUntil(page, 13); },
        act: async (page, { seed }) => { await tdPickAt(page, 1, 45, seed); await tdUntil(page, 24); },
      },
      4: {
        prep: async (page, { seed }) => { await tdWaitStart(page); await tdPickAt(page, 0, 35, seed); await tdUntil(page, 27); },
        act: async (page) => { await tdUntil(page, 42); },
        poster: 0.8,
      },
      // the Match result screen on fixtures (a Practice game has no Pot)
      5: { route: "/design/result?case=trading-duel-won&dev=demo", focus: ["main", ".match-result"], prep: () => sleep(1500), act: async () => { await sleep(5000); } },
    },
  },
  vanguard: {
    focus: [".vg-board", ".vg-army.us"],
    steps: {
      // the setup is dealt: your army face up, Italy's face down; the roster strip counts what Italy has
      1: { prep: () => sleep(300), act: async () => { await sleep(6500); } },
      // the ring round your name runs down 10 s, then you move
      2: {
        prep: (page) => vgMyTurn(page),
        act: async (page) => {
          await sleep(4500);
          const mv = await vgSelect(page);
          if (mv) await mv.mark.click({ force: true, timeout: 1500 }).catch(() => {});
          await sleep(2200);
        },
      },
      // a high rank attacks a lower one, known from the seeded setup: the clash flips the loser face up and ours stays
      3: {
        prep: async (page, { seed }) => { page.__win = await vgUntilWin(page, seed); if (!page.__win) throw new Error("no winning attack reached"); },
        // the attacker is still selected from prep: attack at once, before the turn clock runs out
        act: async (page) => {
          const enemies = (await vgEnemies(page)).length;
          await sleep(700);
          await page.__win.click({ force: true, timeout: 1500 }).catch(() => {});
          await sleep(4200);
          return (await vgEnemies(page)).length === enemies - 1;
        },
        // close on the clash: the attacker and its target, with a few squares round them
        focus: [".vg-piece.us.sel", ".vg-mark.atk"],
        pad: { phone: 95, desktop: 190 },
        speed: 0.75,
        tries: 3,
        poster: 0.75,
      },
      // tap a piece that has a power: its power button appears and what it will do is drawn
      4: {
        prep: (page) => vgMyTurn(page),
        act: async (page) => {
          const pieces = page.locator(".vg-piece.us:not([disabled])");
          const n = await pieces.count();
          for (let i = 0; i < n; i++) {
            await pieces.nth(i).click({ force: true, timeout: 1500 }).catch(() => {});
            await sleep(400);
            if (await page.locator(".vg-power").count()) break;
          }
          await sleep(3500);
        },
        focus: [".vg-board", ".vg-army.us", ".vg-power"],
      },
      // the Match result screen on fixtures (Practice has no Pot)
      5: { route: "/design/result?case=vanguard-won&dev=demo", focus: ["main", ".match-result"], prep: () => sleep(1500), act: async () => { await sleep(5000); } },
    },
  },
};

// ---------------------------------------------------------------- recorder

const only = (process.env.ONLY ?? "").split(",").filter(Boolean).map((s) => s.split(":"));
const wanted = (game, step) => !only.length || only.some(([g, n]) => g === game && (n === undefined || Number(n) === step));
const sets = (process.env.SETS ?? "phone,desktop").split(",");

const HIDE_DEV_UI = "nextjs-portal, [data-nextjs-toast], [data-next-badge-root] { display: none !important; }";

/** Crop rectangle in CSS px: the union of `focus`, padded, widened or heightened to the set's aspect ratio, kept inside the viewport. */
async function cropFor(page, focus, set, padOverride) {
  const vp = set.context.viewport;
  const box = await page.evaluate((sels) => {
    let u = null;
    for (const spec of sels) {
      // "selector|last" keeps only the last match (the second seat at the table is yours)
      const [sel, pick] = spec.split("|");
      const all = [...document.querySelectorAll(sel)];
      for (const e of pick === "last" ? all.slice(-1) : all) {
        const r = e.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        u = u ? { l: Math.min(u.l, r.left), t: Math.min(u.t, r.top), r: Math.max(u.r, r.right), b: Math.max(u.b, r.bottom) } : { l: r.left, t: r.top, r: r.right, b: r.bottom };
      }
    }
    return u;
  }, focus);
  if (!box) throw new Error(`focus not found: ${focus.join(", ")}`);
  const pad = padOverride ?? set.pad;
  let w = box.r - box.l + pad * 2;
  let h = box.b - box.t + pad * 2;
  if (w / h < set.ratio) w = h * set.ratio;
  else h = w / set.ratio;
  if (w > vp.width) [w, h] = [vp.width, vp.width / set.ratio];
  if (h > vp.height) [w, h] = [vp.height * set.ratio, vp.height];
  const x = Math.min(Math.max((box.l + box.r) / 2 - w / 2, 0), vp.width - w);
  const y = Math.min(Math.max((box.t + box.b) / 2 - h / 2, 0), vp.height - h);
  return { x, y, w, h };
}

const pngWidth = (file) => readFileSync(file).readUInt32BE(16);

async function record(browser, game, step, setName, attempt, work) {
  const set = SETS[setName];
  const def = GAMES[game].steps[step];
  const seed = SEED + attempt;
  const ctx = await browser.newContext(set.context);
  // Mark every Game's first-Practice guide as seen, so the recording shows the game, not the guide.
  await ctx.addInitScript(() => {
    for (const g of ["block-puzzle", "holdem", "trading-duel", "vanguard"]) localStorage.setItem(`tesoro:how-to-play:${g}`, "1");
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  ${game}:${step}:${setName} pageerror: ${e.message}`));
  await page.goto(def.route ? `${BASE}${def.route}` : `${BASE}/play/practice?game=${game}&dev=demo&seed=${seed}`, { waitUntil: "domcontentloaded" });
  await page.addStyleTag({ content: HIDE_DEV_UI });
  await sleep(2000);
  const ctxInfo = { seed, set: setName };
  await def.prep?.(page, ctxInfo);
  const crop = await cropFor(page, def.focus ?? GAMES[game].focus, set, def.pad?.[setName]);

  const dir = join(work, `${game}-${step}-${setName}-${attempt}`);
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", (f) => {
    const file = join(dir, `${String(frames.length).padStart(5, "0")}.png`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const vp = set.context.viewport;
  const dsf = set.context.deviceScaleFactor;
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: vp.width * dsf, maxHeight: vp.height * dsf });
  await sleep(300);
  const ok = await def.act(page, ctxInfo);
  await sleep(def.tail ?? 400);
  await cdp.send("Page.stopScreencast");
  await ctx.close();
  return { ok: ok !== false, frames, crop, dir, scale: frames.length ? pngWidth(frames[0].file) / vp.width : dsf };
}

function encode(game, step, setName, take) {
  const set = SETS[setName];
  const def = GAMES[game].steps[step];
  const { frames, crop, scale, dir } = take;
  const real = frames.at(-1).t - frames[0].t;
  const speed = Math.max(def.speed ?? 1, real / MAX_SECS);
  const secs = real / speed;
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${(Math.max(0.001, frames[i + 1] ? frames[i + 1].t - f.t : 0.2) / speed).toFixed(4)}`);
  list.push(`file '${frames.at(-1).file}'`);
  const concat = join(dir, "frames.txt");
  writeFileSync(concat, list.join("\n"));
  const [ow, oh] = set.out;
  const crp = `crop=${even(crop.w * scale)}:${even(crop.h * scale)}:${Math.round(crop.x * scale)}:${Math.round(crop.y * scale)},scale=${ow}:${oh}:flags=lanczos`;
  const fade = `fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, secs - 0.3).toFixed(2)}:d=0.25`;
  const dest = join(OUT, game);
  mkdirSync(dest, { recursive: true });
  const base = join(dest, `${step}-${setName}`);
  const input = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat, "-vf", `${crp},fps=30,${fade}`, "-an", "-pix_fmt", "yuv420p"];
  const sizes = {};
  for (const [ext, codec, crfs] of [
    ["webm", (crf) => ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(crf), "-row-mt", "1", "-deadline", "good", "-cpu-used", "2"], [32, 36, 40, 44, 48, 52]],
    ["mp4", (crf) => ["-c:v", "libx264", "-crf", String(crf), "-preset", "slow", "-movflags", "+faststart"], [24, 27, 30, 33, 37, 41]],
  ]) {
    for (const crf of crfs) {
      execFileSync(FFMPEG, [...input, ...codec(crf), `${base}.${ext}`], { stdio: "inherit" });
      sizes[ext] = Math.round(statSync(`${base}.${ext}`).size / 1024);
      if (sizes[ext] <= MAX_KB) break;
    }
  }
  const at = frames[Math.min(frames.length - 1, Math.floor(frames.length * (def.poster ?? 0.6)))];
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", at.file, "-vf", crp, "-frames:v", "1", "-c:v", "libwebp", "-quality", "82", `${base}.webp`], { stdio: "inherit" });
  const warn = secs < MIN_SECS ? "  (SHORT)" : sizes.webm > MAX_KB || sizes.mp4 > MAX_KB ? "  (OVER SIZE)" : "";
  console.log(`${game}/${step}-${setName}: ${ow}x${oh}, ${secs.toFixed(1)} s (x${speed.toFixed(2)}), webm ${sizes.webm} KB, mp4 ${sizes.mp4} KB${warn}`);
}

const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "htp-"));
const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ["--autoplay-policy=no-user-gesture-required"] });
for (const game of Object.keys(GAMES)) {
  for (const step of [1, 2, 3, 4, 5]) {
    if (!wanted(game, step)) continue;
    // both sets play the same script at once
    await Promise.all(
      sets.map(async (setName) => {
        for (let attempt = 0; attempt < (GAMES[game].steps[step].tries ?? 1); attempt++) {
          try {
            const take = await record(browser, game, step, setName, attempt, work);
            if (!take.ok || take.frames.length < 4) {
              console.log(`${game}/${step}-${setName}: take ${attempt} discarded`);
              continue;
            }
            encode(game, step, setName, take);
            return;
          } catch (e) {
            console.log(`${game}/${step}-${setName}: take ${attempt} failed: ${e.message.split("\n")[0]}`);
          }
        }
        console.log(`${game}/${step}-${setName}: NO CLIP`);
      }),
    );
  }
}
await browser.close();
if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
