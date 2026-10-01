/**
 * Records the landing page's gameplay loops from the real game screens (dev fixtures, no chain):
 * public/art/landing/loop-<game>.{webm,mp4,webp}. Re-run whenever the game UI changes.
 * Needs a dev server with NEXT_PUBLIC_DEV_WALLET=1, playwright-core and ffmpeg (libsvtav1, libx264):
 *
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3131 node scripts/capture-landing-loops.mjs
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/art/landing");
const BASE = process.env.BASE ?? "http://localhost:3131";
const VIEW = { width: 1600, height: 1000 };

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

const LOOPS = [
  { name: "block-puzzle", route: "/design/play?dev=demo", crop: { x: 554, y: 104, w: 760, h: 880 }, act: playBlockPuzzle },
  { name: "holdem", route: "/design/table?facing=1&dev=demo", crop: { x: 384, y: 100, w: 1100, h: 760 }, act: playHoldem },
];

const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "loops-"));
const browser = await chromium.launch();
for (const loop of LOOPS) {
  const ctx = await browser.newContext({ viewport: VIEW, recordVideo: { dir: work, size: VIEW } });
  const t0 = Date.now();
  const page = await ctx.newPage();
  await page.goto(`${BASE}${loop.route}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const start = (Date.now() - t0) / 1000;
  await loop.act(page);
  const end = (Date.now() - t0) / 1000;
  const raw = await page.video().path();
  await ctx.close();

  const { x, y, w, h } = loop.crop;
  const vf = `crop=${w}:${h}:${x}:${y},scale=${Math.round(w * 0.84 / 2) * 2}:-2,fps=30`;
  const cut = ["-y", "-ss", String(start), "-to", String(end), "-i", raw, "-vf", vf, "-an"];
  const out = (ext) => resolve(OUT, `loop-${loop.name}.${ext}`);
  execFileSync("ffmpeg", [...cut, "-c:v", "libsvtav1", "-crf", "40", "-preset", "8", out("webm")], { stdio: "ignore" });
  execFileSync("ffmpeg", [...cut, "-c:v", "libx264", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out("mp4")], { stdio: "ignore" });
  execFileSync("ffmpeg", ["-y", "-sseof", "-0.3", "-i", out("mp4"), "-frames:v", "1", "-c:v", "libwebp", "-quality", "82", out("webp")], { stdio: "ignore" });
  console.log(`loop-${loop.name}: ${(end - start).toFixed(1)} s`);
}
await browser.close();
rmSync(work, { recursive: true, force: true });
