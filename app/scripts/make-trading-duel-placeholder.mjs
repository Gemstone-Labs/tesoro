// TEMPORARY Trading Duel key art, drawn from SVG with sharp, until Astra's art is imported by
// import-final-art.mjs (art-source/ui-redesign/TRADING-DUEL-ART-BRIEF.md). Writes
// public/art/final/trading-duel-{hero,tile}.webp. Sapphire = rising, amber = falling, one emerald Gema.
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/art/final");
mkdirSync(OUT, { recursive: true });
const UP = ["#9cc8ff", "#5aa2ff", "#2d63c8", "#1b3f8f"]; // top facet, body, shade, deep
const DOWN = ["#ffd08a", "#f2a63b", "#b86f12", "#7a4508"];

/** A candle cut like a stone: body with a lit top bevel and a dark pavilion edge. */
function candle(x, w, top, bottom, wickTop, wickBottom, up) {
  const [hi, mid, lo, deep] = up ? UP : DOWN;
  const b = Math.max(6, w * 0.16);
  const id = `c${Math.round(x)}${Math.round(top)}`;
  return `
  <g>
    <rect x="${x + w / 2 - 2}" y="${wickTop}" width="4" height="${wickBottom - wickTop}" fill="${mid}" opacity="0.8"/>
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${mid}"/><stop offset="1" stop-color="${lo}"/></linearGradient></defs>
    <polygon points="${x + b},${top} ${x + w - b},${top} ${x + w},${top + b} ${x + w},${bottom - b} ${x + w - b},${bottom} ${x + b},${bottom} ${x},${bottom - b} ${x},${top + b}" fill="url(#${id})"/>
    <polygon points="${x + b},${top} ${x + w - b},${top} ${x + w - b * 1.8},${top + b * 1.8} ${x + b * 1.8},${top + b * 1.8}" fill="${hi}" opacity="0.85"/>
    <polygon points="${x},${bottom - b} ${x + b},${bottom} ${x + w - b},${bottom} ${x + w},${bottom - b} ${x + w},${bottom - b * 2.2} ${x},${bottom - b * 2.2}" fill="${deep}" opacity="0.55"/>
    <polygon points="${x + b},${top} ${x},${top + b} ${x},${bottom - b}" fill="#fff" opacity="0.13"/>
  </g>`;
}

/** Candles rise, peak, then break sharply. Values are closes in 0..1 of the chart height. */
const SERIES = [0.2, 0.28, 0.25, 0.36, 0.43, 0.4, 0.52, 0.6, 0.57, 0.68, 0.78, 0.9, 0.62, 0.48, 0.52, 0.36];

function chart({ x0, width, base, height, count }) {
  const slot = width / count;
  const w = slot * 0.62;
  let prev = SERIES[0] - 0.05;
  let out = "";
  for (let i = 0; i < count; i++) {
    const close = SERIES[i % SERIES.length];
    const up = close >= prev;
    const lo = Math.min(prev, close);
    const hi = Math.max(prev, close);
    const x = x0 + i * slot;
    const yTop = base - hi * height;
    const yBot = base - lo * height;
    out += candle(x, w, yTop, Math.max(yBot, yTop + 26), yTop - 18 - (i % 3) * 6, yBot + 14 + (i % 2) * 8, up);
    prev = close;
  }
  return out;
}

const gem = (cx, cy, r) => {
  const c = r * 0.32;
  const pts = [[-r + c, -r], [r - c, -r], [r, -r + c], [r, r - c], [r - c, r], [-r + c, r], [-r, r - c], [-r, -r + c]].map(([a, b]) => `${cx + a},${cy + b}`).join(" ");
  const inner = r * 0.55;
  return `<g><polygon points="${pts}" fill="#1fd3a2"/><polygon points="${cx - r + c},${cy - r} ${cx + r - c},${cy - r} ${cx + inner},${cy - inner} ${cx - inner},${cy - inner}" fill="#6af8d6"/><polygon points="${cx - inner},${cy - inner} ${cx + inner},${cy - inner} ${cx + inner},${cy + inner} ${cx - inner},${cy + inner}" fill="#0cbc8c" opacity="0.9"/></g>`;
};

function grid(w, h, horizon) {
  let g = "";
  for (let i = -12; i <= 12; i++) g += `<line x1="${w / 2 + i * 70}" y1="${horizon}" x2="${w / 2 + i * 260}" y2="${h}" stroke="#7fa6d8" stroke-opacity="0.07"/>`;
  for (let j = 1; j <= 8; j++) {
    const y = horizon + (h - horizon) * (j / 8) ** 1.8;
    g += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#7fa6d8" stroke-opacity="0.07"/>`;
  }
  return g;
}

const bg = (w, h) => `
  <defs>
    <radialGradient id="bg" cx="0.68" cy="0.35" r="0.9"><stop offset="0" stop-color="#12233f"/><stop offset="0.55" stop-color="#0a1426"/><stop offset="1" stop-color="#05080f"/></radialGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1424" stop-opacity="0"/><stop offset="1" stop-color="#0b1424"/></linearGradient>
    <radialGradient id="rim" cx="0.5" cy="0" r="0.7"><stop offset="0" stop-color="#cfe2ff" stop-opacity="0.28"/><stop offset="1" stop-color="#cfe2ff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>`;

const hero = (() => {
  const w = 2400, h = 1000, base = 800;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${bg(w, h)}
  ${grid(w, h, 560)}
  <rect x="0" y="${base}" width="${w}" height="${h - base}" fill="url(#floor)"/>
  <ellipse cx="1700" cy="${base + 24}" rx="760" ry="40" fill="#040810" opacity="0.7"/>
  ${chart({ x0: 1000, width: 1280, base, height: 640, count: 16 })}
  <polygon points="1000,0 1900,0 1760,420" fill="url(#rim)"/>
  <line x1="1400" y1="120" x2="2010" y2="270" stroke="#e8f0ff" stroke-opacity="0.45" stroke-width="3"/>
  <line x1="2330" y1="90" x2="2010" y2="270" stroke="#5aa2ff" stroke-opacity="0.55" stroke-width="3"/>
  ${gem(1930, 170, 26)}${gem(1860, 240, 16)}${gem(2040, 130, 12)}
  <rect width="${w}" height="${h}" fill="#05080f" opacity="0" />
  <defs><linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#05080f" stop-opacity="0.85"/><stop offset="0.4" stop-color="#05080f" stop-opacity="0.7"/><stop offset="0.62" stop-color="#05080f" stop-opacity="0"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#fade)"/>
</svg>`;
})();

const tile = (() => {
  const w = 1024, h = 1024;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  ${bg(w, h)}
  ${grid(w, h, 520)}
  <ellipse cx="512" cy="900" rx="400" ry="36" fill="#040810" opacity="0.7"/>
  ${candle(150, 190, 420, 880, 330, 920, true)}
  ${candle(414, 190, 300, 760, 210, 820, true)}
  ${candle(678, 190, 520, 900, 440, 960, false)}
  <line x1="60" y1="110" x2="512" y2="300" stroke="#e8f0ff" stroke-opacity="0.45" stroke-width="3"/>
  <line x1="964" y1="110" x2="512" y2="300" stroke="#5aa2ff" stroke-opacity="0.55" stroke-width="3"/>
  ${gem(760, 190, 40)}${gem(640, 270, 20)}
</svg>`;
})();

await sharp(Buffer.from(hero)).webp({ quality: 84 }).toFile(resolve(OUT, "trading-duel-hero.webp"));
await sharp(Buffer.from(tile)).resize(768).webp({ quality: 84 }).toFile(resolve(OUT, "trading-duel-tile.webp"));
console.log("trading-duel-hero.webp, trading-duel-tile.webp");
