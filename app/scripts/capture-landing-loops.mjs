/**
 * Records the landing page's gameplay loops from the real game screens (dev fixtures, no chain):
 * public/art/landing/loop-<game>.{webm,mp4,webp}. Re-run whenever the game UI changes, then copy the
 * sizes it prints into `GAMES` in components/landing/Games.tsx.
 * Frames come from the browser's screencast as PNGs (Playwright's own video is too soft at this size).
 * Needs a dev server with NEXT_PUBLIC_DEV_WALLET=1, playwright-core and ffmpeg (libsvtav1, libx264):
 *
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3131 node scripts/capture-landing-loops.mjs
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

/** Tap a piece, then board cells until it lands; a dozen placements clears a line or two. */
async function playBlockPuzzle(page) {
  await page.waitForSelector(".bp-slot:not(:disabled)", { timeout: 20000 });
  const cells = [56, 48, 40, 60, 52, 44, 32, 36, 24, 28, 16, 20, 8, 12, 0, 4];
  for (let n = 0; n < 14; n++) {
    const slots = await page.$$(".bp-slot:not(:disabled):not(.used)");
    if (!slots.length) break;
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
    await page.waitForTimeout(450);
  }
  await page.waitForTimeout(800);
}

/** The table on a fixed River decision: size a raise with the presets and the slider (no action is sent). */
async function playHoldem(page) {
  await page.waitForSelector("text=Raise to", { timeout: 20000 }).catch(() => {});
  for (const name of ["Min", "½ pot", "Pot", "Min"]) {
    await page.getByRole("button", { name, exact: true }).first().hover();
    await page.waitForTimeout(350);
    await page.getByRole("button", { name, exact: true }).first().click();
    await page.waitForTimeout(900);
  }
  const slider = page.locator('input[type="range"]').first();
  const box = await slider.boundingBox();
  if (box) {
    await page.mouse.move(box.x + 8, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 0; i <= 30; i++) {
      await page.mouse.move(box.x + 8 + (box.width * 0.7 * i) / 30, box.y + box.height / 2);
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
  }
  await page.getByRole("button", { name: /^Call/ }).first().hover();
  await page.waitForTimeout(1400);
}

/**
 * Each loop is cropped to the game itself: from the top of `from` to the bottom of `to`, plus PAD.
 * `speed` plays the recording faster: the script finds each Block Puzzle placement by trial, slower than a Player.
 */
const LOOPS = [
  { name: "block-puzzle", route: "/design/play?dev=demo", from: ".bpx-bar", to: ".bp-tray", act: playBlockPuzzle, speed: 1.75 },
  { name: "holdem", route: "/design/table?facing=1&dev=demo", from: ".hdx-head", to: ".hdx-actions", act: playHoldem, speed: 1 },
];

const even = (n) => Math.round(n / 2) * 2;

const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "loops-"));
const browser = await chromium.launch();
for (const loop of LOOPS) {
  const ctx = await browser.newContext({ viewport: VIEW });
  const page = await ctx.newPage();
  await page.goto(`${BASE}${loop.route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const crop = await page.evaluate(
    ([from, to, pad]) => {
      const a = document.querySelector(from).getBoundingClientRect();
      const b = document.querySelector(to).getBoundingClientRect();
      const x = Math.min(a.left, b.left) - pad;
      const y = a.top - pad;
      return { x, y, w: Math.max(a.right, b.right) + pad - x, h: b.bottom + pad - y };
    },
    [loop.from, loop.to, PAD],
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

  const [w, h] = [even(crop.w), even(crop.h)];
  const vf = `crop=${w}:${h}:${Math.round(crop.x)}:${Math.round(crop.y)},fps=30`;
  const cut = ["-y", "-f", "concat", "-safe", "0", "-i", concat, "-vf", vf, "-an", "-pix_fmt", "yuv420p"];
  const out = (ext) => resolve(OUT, `loop-${loop.name}.${ext}`);
  execFileSync("ffmpeg", [...cut, "-c:v", "libsvtav1", "-crf", "34", "-preset", "6", out("webm")], { stdio: "ignore" });
  execFileSync("ffmpeg", [...cut, "-c:v", "libx264", "-crf", "24", "-movflags", "+faststart", out("mp4")], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-i", frames.at(-1).file, "-vf", vf.replace(",fps=30", ""), "-frames:v", "1", "-c:v", "libwebp", "-quality", "86", out("webp")], { stdio: "ignore" });
  console.log(`loop-${loop.name}: ${w}x${h}, ${((frames.at(-1).t - frames[0].t) / loop.speed).toFixed(1)} s`);
}
await browser.close();
rmSync(work, { recursive: true, force: true });
