/**
 * Checks every How to play clip the way a browser will meet it:
 *  (a) ffprobe: pix_fmt yuv420p and limited (tv) colour range, the only kind browsers decode;
 *  (b) motion continuity (motion-continuity.mjs): movement must arrive as a run of changing frames, not isolated changed frames
 *      with static ones around them (animations that teleport);
 *  (c) real playback in a HEADED Chromium (on the private hidden screen of htp-screen.mjs, never on the person's own screen):
 *      currentTime must pass 1 s within 5 s with no video error. A headless browser decodes full-range files that real browsers
 *      refuse, so it proves nothing.
 *
 *   LIBSEAT_BACKEND=noop PW=/path/to/playwright-core CHROME=/usr/bin/chromium node scripts/check-how-to-play-clips.mjs
 *   env: DIR=<clips dir> (default public/art/how-to-play), NO_PLAYBACK=1 to skip (c).
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { screenDown, screenUp } from "./htp-screen.mjs";
import { MAX_SHARE, continuity, frameDiffs } from "./motion-continuity.mjs";

const DIR = resolve(process.env.DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../public/art/how-to-play"));
const files = readdirSync(DIR, { recursive: true }).filter((f) => /\.(webm|mp4)$/.test(f)).sort().map((f) => join(DIR, f));

let probeFail = 0;
for (const f of files) {
  const [pix, range] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt,color_range", "-of", "csv=p=0", f], { encoding: "utf8" }).trim().split(",");
  if (pix !== "yuv420p" || range !== "tv") { probeFail++; console.log(`PROBE FAIL ${f}: ${pix}/${range}`); }
}
console.log(`ffprobe yuv420p/tv: ${files.length - probeFail}/${files.length} pass`);

let smoothFail = 0;
const mp4s = files.filter((f) => f.endsWith(".mp4"));
for (const f of mp4s) {
  const r = continuity(await frameDiffs(f));
  if (r.share >= MAX_SHARE) { smoothFail++; console.log(`NOT SMOOTH ${f}: ${(r.share * 100).toFixed(1)}% of ${r.inside} pairs inside movements are still`); }
}
console.log(`motion continuity (mp4): ${mp4s.length - smoothFail}/${mp4s.length} pass`);

let playFail = 0;
if (!process.env.NO_PLAYBACK) {
  const screen = await screenUp("desktop");
  try {
    for (const f of files) {
      let r;
      try {
        await screen.page.goto(`file://${f}`);
        r = await screen.page.evaluate(async () => {
          const v = document.querySelector("video");
          v.muted = true;
          await v.play().catch(() => {});
          const t0 = performance.now();
          while (performance.now() - t0 < 5000 && v.currentTime <= 1 && !v.error) await new Promise((ok) => setTimeout(ok, 100));
          return { t: v.currentTime, error: v.error?.code ?? null };
        });
      } catch (e) {
        r = { t: 0, error: `browser: ${e.message.split("\n")[0]}` };
      }
      if (r.error || r.t <= 1) { playFail++; console.log(`PLAY FAIL ${f}: currentTime ${r.t.toFixed(2)}, error ${r.error}`); }
    }
  } finally {
    await screenDown();
  }
  console.log(`headed playback: ${files.length - playFail}/${files.length} play`);
}
process.exit(probeFail + smoothFail + playFail ? 1 : 0);
