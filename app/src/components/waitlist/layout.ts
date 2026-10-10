import { DESIGN, LINES, type Line } from "./geometry";

export type Block = { x: number; y: number; size: number; hue: Hue; t: number; i: number; gem: boolean };
export type Hue = "amber" | "cyan" | "pink" | "violet" | "emerald";

const HUES: Hue[] = ["amber", "cyan", "pink", "violet"];

/** Deterministic: the same blocks on the server and in every build. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A row sits `offset` pitches from the line towards the videos (negative: towards the form). */
type Row = { offset: number; scale: number; keep: number };
const ROWS: Record<keyof typeof LINES, Row[]> = {
  wide: [
    { offset: -0.3, scale: 1, keep: 0.9 },
    { offset: 0.5, scale: 1, keep: 1 },
    { offset: 1.45, scale: 0.78, keep: 0.72 },
    { offset: 2.25, scale: 0.56, keep: 0.45 },
    { offset: 2.95, scale: 0.4, keep: 0.24 },
  ],
  tall: [
    { offset: -0.4, scale: 1, keep: 0.9 },
    { offset: 0.5, scale: 1, keep: 1 },
    { offset: 1.4, scale: 0.72, keep: 0.65 },
    { offset: 2.1, scale: 0.5, keep: 0.35 },
  ],
};
/** Block edge in design px at scale 1. */
const UNIT = { wide: 42, tall: 28 };
/** At most two emerald blocks (the emerald rule): every other block is one of the four Block Puzzle jewels. */
const EMERALD_AT = { wide: [11, 29], tall: [5, 14] };

export function layoutBlocks(variant: keyof typeof LINES): Block[] {
  const line: Line = LINES[variant];
  const { w, h } = DESIGN[variant];
  const dx = (line.x2 - line.x1) * w;
  const dy = (line.y2 - line.y1) * h;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  // Normal towards the videos (up and to the right).
  const nx = uy;
  const ny = -ux;
  const unit = UNIT[variant];
  const rand = rng(variant === "wide" ? 7 : 19);
  const blocks: Block[] = [];
  let i = 0;
  let prev: Hue | undefined;
  let main = 0;
  ROWS[variant].forEach((row, r) => {
    const size = unit * row.scale;
    const step = size * 0.96;
    // Alternate rows start half a block along so the band reads as staggered stonework.
    for (let s = (r % 2 ? 0.5 : 0) * step - step; s <= len + step; s += step) {
      if (rand() > row.keep) continue;
      const jitter = (rand() - 0.5) * size * 0.16;
      const cx = line.x1 * w + ux * s + nx * (row.offset * unit + jitter);
      const cy = line.y1 * h + uy * s + ny * (row.offset * unit + jitter);
      if (cx < -size || cx > w + size || cy < -size || cy > h + size) continue;
      let hue = HUES[Math.floor(rand() * HUES.length)];
      if (hue === prev) hue = HUES[(HUES.indexOf(hue) + 1) % HUES.length];
      prev = hue;
      const gem = r === 1 && EMERALD_AT[variant].includes(main++);
      blocks.push({ x: (cx / w) * 100, y: (cy / h) * 100, size: (size / w) * 100, hue: gem ? "emerald" : hue, t: s / len, i: i++, gem });
    }
  });
  return blocks;
}
