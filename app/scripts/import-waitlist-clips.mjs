// Turns the stock clips listed in art-source/waitlist/sources.json (workspace, outside the repo) into the
// waitlist's background wall: 9:16, 480 px wide, silent, lightly graded, as WebM (AV1) + MP4 (H.264) + WebP poster
// in public/art/waitlist. Re-run `node scripts/import-waitlist-clips.mjs` after editing sources.json (ONLY=clip-5,clip-7 for a few).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.WAITLIST_SRC ?? resolve(process.env.HOME, "Work/gemstone-labs/tesoro/art-source/waitlist");
const OUT = resolve(here, "../public/art/waitlist");
const W = 480;
const H = 854;
const FPS = 24;
// Per file: the wall plays 12 to 20 tiles at once at ~25% of the viewport each, so small and soft is fine.
const LIMIT = { webm: 125_000, mp4: 190_000 };

mkdirSync(OUT, { recursive: true });
const only = process.env.ONLY?.split(",");
const clips = JSON.parse(readFileSync(resolve(SRC, "sources.json"), "utf8")).clips.filter((c) => !only || only.includes(c.out));
const ff = (...args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
const size = (p) => statSync(p).size;

/** A 9:16 window of the source: all of it, or a zoomed one around (cx, cy). */
function cropFilter({ w = 1, cx = 0.5, cy = 0.5 } = {}) {
  const cw = `iw*${w}`;
  const ch = `iw*${w}*16/9`;
  return `crop=${cw}:${ch}:(iw-${cw})*${cx}:(ih-${ch})*${cy}`;
}

/** Re-encodes with rising CRF until the file is under its limit. */
function encode(args, out, crfs, limit) {
  for (const crf of crfs) {
    ff(...args(crf), out);
    if (size(out) <= limit) return crf;
  }
  return crfs.at(-1);
}

let total = 0;
for (const c of clips) {
  const vf = [
    cropFilter(c.crop),
    `scale=${W}:${H}:flags=lanczos`,
    `fps=${FPS}`,
    "eq=saturation=0.82:brightness=-0.05:contrast=1.03",
    "format=yuv420p",
  ].join(",");
  const input = ["-ss", String(c.trimStart), "-t", String(c.trimSeconds), "-i", resolve(SRC, c.file), "-an", "-vf", vf];
  const base = resolve(OUT, c.out);
  const webmCrf = encode((crf) => [...input, "-c:v", "libsvtav1", "-crf", String(crf), "-preset", "6", "-g", "48"], `${base}.webm`, [40, 44, 48, 52, 56], LIMIT.webm);
  const mp4Crf = encode((crf) => [...input, "-c:v", "libx264", "-crf", String(crf), "-preset", "slow", "-profile:v", "main", "-movflags", "+faststart"], `${base}.mp4`, [28, 31, 34, 37, 40], LIMIT.mp4);
  ff("-ss", String(c.trimStart + 0.4), "-i", resolve(SRC, c.file), "-frames:v", "1", "-vf", vf, "-c:v", "libwebp", "-quality", "70", `${base}.webp`);
  const sizes = ["webm", "mp4", "webp"].map((e) => size(`${base}.${e}`));
  total += sizes.reduce((a, b) => a + b, 0);
  console.log(`${c.out}  webm ${(sizes[0] / 1024).toFixed(0)} KB (crf ${webmCrf})  mp4 ${(sizes[1] / 1024).toFixed(0)} KB (crf ${mp4Crf})  poster ${(sizes[2] / 1024).toFixed(0)} KB`);
}
console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB`);
