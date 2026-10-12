/**
 * Records the waitlist wall's clips: real gameplay of Tesoro's three Games (practice mode, a running app) and of
 * open-source casual web games (cloned outside the repo into art-source/waitlist/games, served by any static
 * server), each cropped to a square around the game. Frames come from the CDP screencast, like
 * capture-landing-loops.mjs. Output: art-source/waitlist/recorded/<name>.mp4 (near-lossless; the import script
 * makes the small files). Needs ffmpeg and playwright-core.
 *
 *   # the app on :3217 (next start) and the games on :8765 (python3 -m http.server 8765 --bind 127.0.0.1)
 *   PW=/path/to/playwright-core/index.mjs ONLY=2048,snake node scripts/record-waitlist-games.mjs
 *   PROBE=1 records 4 s per game, to check the framing.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(process.env.PW ?? "playwright-core");
const WORKSPACE = process.env.WAITLIST_SRC ?? join(import.meta.dirname, "../../../art-source/waitlist");
const APP = process.env.APP ?? "http://localhost:3217";
const GAMES = process.env.GAMES ?? "http://localhost:8765";
const SECONDS = process.env.PROBE ? 4 : 11;
const OUT = join(WORKSPACE, "recorded");
mkdirSync(OUT, { recursive: true });

const sleep = (page, ms) => page.waitForTimeout(ms);
const until = (t0, ms) => Date.now() - t0 < ms;

/** Block Puzzle: tap a piece, then board cells until it lands (as the landing recorder does). */
async function blockPuzzle(page, ms) {
  await page.getByRole("button", { name: "Start practice" }).click();
  await page.waitForSelector(".bp-slot:not(:disabled)", { timeout: 20000 });
  const cells = [56, 48, 40, 60, 52, 44, 32, 36, 24, 28, 16, 20, 8, 12, 0, 4, 58, 50, 42, 34, 26, 18, 10, 2];
  const t0 = Date.now();
  while (until(t0, ms)) {
    const slots = await page.$$(".bp-slot:not(:disabled):not(.used)");
    let placed = false;
    for (const s of slots) {
      await s.click();
      for (const cell of cells) {
        const before = await page.locator(".bp-cell.on").count();
        await page.locator(".bp-board .bp-cell").nth(cell).click({ force: true });
        if ((await page.locator(".bp-cell.on").count()) !== before) {
          placed = true;
          break;
        }
      }
      if (placed) break;
    }
    if (!placed) break;
    await sleep(page, 350);
  }
}

/** Hold'em against the practice bot: check or call every time it is our turn. */
async function holdem(page, ms) {
  const t0 = Date.now();
  while (until(t0, ms)) {
    const go = page.locator("button:not(:disabled)").filter({ hasText: /^(Check|Call|Next hand|Deal)/ }).first();
    await go.click({ timeout: 400 }).catch(() => {});
    await sleep(page, 700);
  }
}

/** Trading Duel practice: a 60 s round, opening and closing positions on the live price. */
async function startDuel(page) {
  await page.getByRole("button", { name: "60 seconds" }).click();
  await page.getByRole("button", { name: "Start practice" }).click();
  await page.waitForSelector(".td-btn.up:not(:disabled)", { timeout: 60000 });
}

async function tradingDuel(page, ms) {
  const t0 = Date.now();
  let n = 0;
  while (until(t0, ms)) {
    await page.getByRole("button", { name: n % 2 ? /Short/ : /Long/ }).first().click().catch(() => {});
    n++;
    await sleep(page, 2600);
    await page.getByRole("button", { name: /^Close/ }).first().click({ timeout: 500 }).catch(() => {});
    await sleep(page, 800);
  }
}

async function keys(page, ms, sequence, gap) {
  const t0 = Date.now();
  let i = 0;
  while (until(t0, ms)) {
    await page.keyboard.press(sequence[i++ % sequence.length]);
    await sleep(page, gap);
  }
}

/**
 * name, where the page is, the element the square is centred on (+ `side` to force its size), and what plays.
 * `side` is in CSS px; by default the square is the element's longer side plus `pad` each side.
 */
const LIST = [
  { name: "block-puzzle", app: "/play/practice", viewport: [1280, 900], box: ".bp-board", pad: 6, act: blockPuzzle },
  { name: "holdem", app: "/play/practice?game=holdem", viewport: [1280, 900], box: ".hdx-table", side: 540, act: holdem },
  { name: "trading-duel", app: "/play/practice?game=trading-duel", viewport: [1280, 900], box: ".td-chart", side: 600, at: [272, 270], pre: startDuel, act: tradingDuel },
  {
    name: "2048", game: "/2048/index.html", viewport: [700, 800], box: ".game-container", pad: 16,
    act: (page, ms) => keys(page, ms, ["ArrowDown", "ArrowLeft", "ArrowDown", "ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"], 140),
  },
  {
    name: "match-3", game: "/Match-3-Game-HTML5/match3.html", viewport: [900, 700], box: "#viewport", side: 360, at: [237, 98],
    act: async (page, ms) => {
      const r = await page.locator("#viewport").boundingBox();
      await page.mouse.click(r.x + 105, r.y + 385);
      await sleep(page, ms);
    },
  },
  {
    name: "plinko", game: "/html5-game-plinko/index.html", viewport: [800, 800], box: "#game", pad: 0,
    act: async (page, ms) => {
      const r = await page.locator("#game").boundingBox();
      const t0 = Date.now();
      let n = 0;
      while (until(t0, ms)) {
        await page.mouse.click(r.x + r.width * (0.15 + ((n++ * 0.29) % 0.7)), r.y + 40);
        await sleep(page, 650);
      }
    },
  },
  {
    name: "color-flood", game: "/html5-game-color-flood/index.html", viewport: [800, 900], box: "#game", pad: 14,
    act: async (page, ms) => {
      const t0 = Date.now();
      let n = 0;
      while (until(t0, ms)) {
        await page.locator("#swatches button").nth(n++ % 6).click({ timeout: 800 }).catch(() => {});
        await sleep(page, 800);
      }
    },
  },
  {
    name: "bubble-shooter", game: "/html5-game-bubble-shooter/index.html", viewport: [1000, 1000], box: "#game", pad: 30,
    act: async (page, ms) => {
      const r = await page.locator("#game").boundingBox();
      const t0 = Date.now();
      let n = 0;
      while (until(t0, ms)) {
        await page.mouse.move(r.x + r.width * (0.12 + ((n * 0.37) % 0.76)), r.y + r.height * 0.18, { steps: 6 });
        await page.mouse.click(r.x + r.width * (0.12 + ((n * 0.37) % 0.76)), r.y + r.height * 0.18);
        n++;
        await sleep(page, 850);
      }
    },
  },
  {
    name: "breakout", game: "/Breakout/index.html", viewport: [1000, 900], box: "#mainGame", pad: 0, dark: true,
    act: async (page, ms) => {
      await page.evaluate(() => {
        setInterval(() => {
          const b = balls[0];
          const mid = paddle_X + PADDLE_WIDTH / 2;
          heldKeys.ArrowLeft = b.x < mid - 14;
          heldKeys.ArrowRight = b.x > mid + 14;
        }, 16);
      });
      await sleep(page, 400);
      await page.mouse.click(40, 40);
      await sleep(page, ms);
    },
  },
  {
    name: "memory", game: "/memory-game/index.html", viewport: [900, 700], box: "#memory--cards", pad: 24,
    act: async (page, ms) => {
      await page.selectOption("#memory--settings-grid", "2x3");
      await page.click("#memory--settings-reset");
      await sleep(page, 700);
      const t0 = Date.now();
      while (until(t0, ms)) {
        const cards = page.locator("#memory--cards li:not(.matched):not(.flipped)");
        const n = await cards.count();
        if (n < 2) break;
        await cards.nth(Math.floor(Math.random() * n)).click().catch(() => {});
        await sleep(page, 650);
      }
    },
  },
  {
    name: "snake", game: "/snake/index.html", viewport: [700, 700], box: "#game", pad: 14,
    act: async (page, ms) => {
      await page.evaluate(() => {
        const wrap = (d, size) => (Math.abs(d) > size / 2 ? -Math.sign(d) * (size - Math.abs(d)) : d);
        setInterval(() => {
          const dx = wrap(apple.x - snake.x, canvas.width);
          const dy = wrap(apple.y - snake.y, canvas.height);
          const key = (c) => document.dispatchEvent(Object.assign(new Event("keydown"), { which: c }));
          if (dx !== 0 && (dy === 0 || snake.dy !== 0 || Math.abs(dx) > 0)) key(dx > 0 ? 39 : 37);
          else if (dy !== 0) key(dy > 0 ? 40 : 38);
        }, 60);
      });
      await sleep(page, ms);
    },
  },
];

const only = process.env.ONLY?.split(",");
const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "waitlist-rec-"));
const browser = await chromium.launch();
for (const g of LIST.filter((g) => !only || only.includes(g.name))) {
  const ctx = await browser.newContext({ viewport: { width: g.viewport[0], height: g.viewport[1] } });
  const page = await ctx.newPage();
  await page.goto((g.app ? APP + g.app : GAMES + g.game), { waitUntil: g.app ? "load" : "networkidle", timeout: 90000 });
  if (g.dark) await page.addStyleTag({ content: "html,body{background:#000!important}" });
  await sleep(page, 2500);
  await g.pre?.(page);
  const rect = await page.locator(g.box).first().boundingBox();
  const [vw, vh] = g.viewport;
  const side = Math.min(Math.round(g.side ?? Math.max(rect.width, rect.height) + 2 * (g.pad ?? 0)), vw, vh);
  const fit = (v, max) => Math.max(0, Math.min(Math.round(v), max - side));
  const x = g.at?.[0] ?? fit(rect.x + rect.width / 2 - side / 2, vw);
  const y = g.at?.[1] ?? fit(rect.y + rect.height / 2 - side / 2, vh);

  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", (f) => {
    const file = join(work, `${g.name}-${String(frames.length).padStart(5, "0")}.png`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: g.viewport[0], maxHeight: g.viewport[1] });
  await sleep(page, 200);
  await g.act(page, SECONDS * 1000);
  await cdp.send("Page.stopScreencast");
  await ctx.close();

  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1] ? frames[i + 1].t - f.t : 0.1)).toFixed(4)}`);
  list.push(`file '${frames.at(-1).file}'`);
  const concat = join(work, `${g.name}.txt`);
  writeFileSync(concat, list.join("\n"));
  const vf = `crop=${side}:${side}:${x}:${y},scale=720:720:flags=lanczos,fps=30`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", concat, "-vf", vf, "-an", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "14", join(OUT, `${g.name}.mp4`)]);
  console.log(`${g.name}: ${side}px square at ${x},${y}, ${(frames.at(-1).t - frames[0].t).toFixed(1)} s, ${frames.length} frames`);
}
await browser.close();
rmSync(work, { recursive: true, force: true });
