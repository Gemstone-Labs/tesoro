/**
 * Checks every How to play clip the way a browser will meet it:
 *  (a) ffprobe: pix_fmt yuv420p and limited (tv) colour range, the only kind browsers decode;
 *  (b) real playback in a HEADED Chromium window: currentTime must pass 1 s within 5 s with no video error
 *      (a headless browser decodes full-range files that real browsers refuse, so it proves nothing).
 *
 *   PW=/path/to/playwright-core CHROME=/usr/bin/chromium node scripts/check-how-to-play-clips.mjs
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)(process.env.PW ?? "playwright-core");
const DIR = resolve(process.env.DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../public/art/how-to-play"));
const files = readdirSync(DIR, { recursive: true }).filter((f) => /\.(webm|mp4)$/.test(f)).sort().map((f) => join(DIR, f));

let probeFail = 0;
for (const f of files) {
  const [pix, range] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,color_range", "-of", "csv=p=0", f], { encoding: "utf8" }).trim().split(",");
  if (pix !== "yuv420p" || range !== "tv") { probeFail++; console.log(`PROBE FAIL ${f}: ${pix}/${range}`); }
}
console.log(`ffprobe yuv420p/tv: ${files.length - probeFail}/${files.length} pass`);

const launch = () => chromium.launch({ executablePath: process.env.CHROME, headless: false });
let browser = await launch();
let playFail = 0;
for (const f of files) {
  if (!browser.isConnected()) browser = await launch();
  const page = await browser.newPage();
  const r = await (async () => {
    await page.goto(`file://${f}`);
    return page.evaluate(async () => {
    const v = document.querySelector("video");
    v.muted = true;
    await v.play().catch(() => {});
    const t0 = performance.now();
    while (performance.now() - t0 < 5000 && v.currentTime <= 1 && !v.error) await new Promise((ok) => setTimeout(ok, 100));
    return { t: v.currentTime, error: v.error?.code ?? null };
    });
  })().catch((e) => ({ t: 0, error: `browser died: ${e.message.split("\n")[0]}` }));
  if (r.error || r.t <= 1) { playFail++; console.log(`PLAY FAIL ${f}: currentTime ${r.t.toFixed(2)}, error ${r.error}`); }
  await page.close().catch(() => {});
}
await browser.close().catch(() => {});
console.log(`headed playback: ${files.length - playFail}/${files.length} play`);
process.exit(probeFail + playFail ? 1 : 0);
