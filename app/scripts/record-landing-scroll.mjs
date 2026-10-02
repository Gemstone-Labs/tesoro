/**
 * A screen recording of the landing page scrolled top to bottom with motion on (desktop, dark):
 * docs/screens/landing-scroll.mp4. Wheel input, so Lenis, the Gemas pin and every scrub run as for a visitor.
 *
 *   PW=/path/to/node_modules/playwright-core BASE=http://localhost:3132 node scripts/record-landing-scroll.mjs
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? "playwright-core");
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/screens/landing-scroll.mp4");
const BASE = process.env.BASE ?? "http://localhost:3132";
const VIEW = { width: 1440, height: 900 };

const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "scroll-"));
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: VIEW, recordVideo: { dir: work, size: VIEW } });
await ctx.addInitScript(() => localStorage.setItem("tesoro-landing-theme", "dark"));
const t0 = Date.now();
const page = await ctx.newPage();
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
const start = (Date.now() - t0) / 1000;
await page.waitForTimeout(2500);
await page.mouse.move(VIEW.width * 0.6, VIEW.height * 0.5);
for (;;) {
  const [y, max] = await page.evaluate(() => [scrollY, document.documentElement.scrollHeight - innerHeight]);
  if (y >= max - 2) break;
  await page.mouse.wheel(0, 90);
  await page.waitForTimeout(60);
}
await page.waitForTimeout(2000);
const raw = await page.video().path();
await ctx.close();
await browser.close();

execFileSync("ffmpeg", ["-y", "-ss", String(start), "-i", raw, "-an", "-c:v", "libx264", "-crf", "28", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT], { stdio: "ignore" });
rmSync(work, { recursive: true, force: true });
console.log(OUT);
