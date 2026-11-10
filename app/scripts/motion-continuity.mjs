/**
 * Motion continuity of a clip: does movement arrive as a run of changing frames, or as isolated changed frames with static ones
 * around them (animations that teleport)? Frames are shrunk to 120 px wide grey; the mean absolute difference of each frame pair is
 * its motion (120 px wide, 240 for desktop clips). A pair is "inside a movement" when a moving pair (diff > MOVING) lies within WINDOW frames before it AND within WINDOW
 * frames after it. Inside movements, the share of near-zero pairs (diff < STILL) must stay under MAX_SHARE.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const MOVING = 0.3;
export const STILL = 0.05;
export const WINDOW = 5;
export const MAX_SHARE = 0.1;
/** Frames are shrunk to 120 px wide (240 for the 960 px desktop clips, so a piece moving on them covers as many pixels as on the phone clips). */
const widthFor = (w) => (w > 600 ? 240 : 120);

export async function frameDiffs(file, ffmpeg = process.env.FFMPEG ?? "ffmpeg") {
  const probe = await promisify(execFile)(ffmpeg.replace(/ffmpeg$/, "ffprobe"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, h] = probe.stdout.trim().split(",").map(Number);
  const W = widthFor(w);
  const H = Math.round((h / w) * W);
  const { stdout } = await promisify(execFile)(ffmpeg, ["-v", "error", "-i", file, "-vf", `scale=${W}:${H}:flags=area,format=gray`, "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 1 << 29 });
  const size = W * H;
  const n = Math.floor(stdout.length / size);
  const diffs = [];
  for (let f = 1; f < n; f++) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Math.abs(stdout[f * size + i] - stdout[(f - 1) * size + i]);
    diffs.push(sum / size);
  }
  return diffs;
}

export function continuity(diffs) {
  let inside = 0;
  let still = 0;
  for (let i = 0; i < diffs.length; i++) {
    let before = false;
    let after = false;
    for (let j = Math.max(0, i - WINDOW); j <= i; j++) if (diffs[j] > MOVING) before = true;
    for (let j = i; j <= Math.min(diffs.length - 1, i + WINDOW); j++) if (diffs[j] > MOVING) after = true;
    if (!(before && after)) continue;
    inside++;
    if (diffs[i] < STILL) still++;
  }
  return { inside, still, share: inside ? still / inside : 0, pairs: diffs.length };
}

/** Throws with the fix named when movement in `file` arrives as isolated changed frames. */
export async function assertSmooth(file) {
  const r = continuity(await frameDiffs(file));
  if (r.share >= MAX_SHARE) {
    throw new Error(`${file} is not smooth: ${(r.share * 100).toFixed(0)}% of the frame pairs inside movements are still (${r.still}/${r.inside}); animations teleport. Record the screen at 60 fps (headed GPU Chromium + wf-recorder), not the CDP screencast.`);
  }
  return r;
}

if (process.argv[1]?.endsWith("motion-continuity.mjs")) {
  for (const f of process.argv.slice(2)) {
    const r = continuity(await frameDiffs(f));
    console.log(`${r.share >= MAX_SHARE ? "FAIL" : "ok  "} ${f}: inside ${r.inside}, still ${r.still}, share ${(r.share * 100).toFixed(1)}% (pairs ${r.pairs})`);
  }
}
