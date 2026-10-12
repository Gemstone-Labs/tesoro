/**
 * Builds the Tesoro brand from geometry (no auto-trace): the Facet T mark, the chamfered-caps wordmark,
 * lockups, shared path data for the React component, icons and the social cards.
 * Needs `opentype.js`, `sharp` and `@fontsource/schibsted-grotesk` resolvable from BRAND_DEPS
 * (path to a package.json that has them installed; the font is only used for the social card headline):
 *   BRAND_DEPS=/path/to/package.json node app/scripts/build-brand.mjs
 * Sources (outside the repo): art-source/ui-redesign/brand/og-image.png (social card background art).
 * Exports copies to art-source/brand-v2/export/.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.BRAND_DEPS ?? import.meta.url);
const opentype = require("opentype.js");
const sharp = require("sharp");
const fontFile = require.resolve("@fontsource/schibsted-grotesk/files/schibsted-grotesk-latin-800-normal.woff");

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const ART = process.env.ART_SOURCE ?? path.resolve(here, "../../../art-source");
const SRC = process.env.BRAND_SRC ?? path.join(ART, "ui-redesign/brand");
const EXPORT = process.env.BRAND_EXPORT ?? path.join(ART, "brand-v2/export");
const out = (p) => path.join(app, p);
for (const d of [out("public/brand"), out("public/icons"), out("src/components/brand"), EXPORT]) fs.mkdirSync(d, { recursive: true });

// ---- the Facet T: an emerald-cut octagon whose table and stem facets form the T ----
const S = 1000;
const poly = (pts) => "M" + pts.map(([x, y]) => `${x} ${y}`).join("L") + "Z";
const octagon = [[270, 0], [730, 0], [1000, 270], [1000, 730], [730, 1000], [270, 1000], [0, 730], [0, 270]];
const table = [[270, 0], [730, 0], [900, 310], [100, 310]];
const left = [[0, 400], [380, 470], [380, 1000], [270, 1000], [0, 730]];
const right = [[1000, 400], [620, 470], [620, 1000], [730, 1000], [1000, 730]];
// one colour: the side facets drop away and the T stands alone
const monoT = [[270, 0], [730, 0], [1000, 270], [1000, 400], [620, 470], [620, 1000], [380, 1000], [380, 470], [0, 400], [0, 270]];
const MK = { octagon: poly(octagon), table: poly(table), left: poly(left), right: poly(right), mono: poly(monoT) };

// flat facet tones, light from the upper left; the light-background set is deeper
const PAL = {
  dark: { table: "#8FF5CF", body: "#2DBE8C", left: "#0F7D5B", right: "#0B6B4E", text: "#F5F3EE" },
  light: { table: "#5FD9AE", body: "#0E9E70", left: "#086045", right: "#064B37", text: "#0C0E10" },
};
const markBody = (p) =>
  `<path fill="${p.body}" d="${MK.octagon}"/><path fill="${p.table}" d="${MK.table}"/><path fill="${p.left}" d="${MK.left}"/><path fill="${p.right}" d="${MK.right}"/>`;
const svg = (w, h, inner, title = "Tesoro") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}">${inner}</svg>\n`;
const write = (name, s) => { fs.writeFileSync(out("public/brand/" + name), s); fs.writeFileSync(path.join(EXPORT, name), s); };

write("tesoro-mark.svg", svg(S, S, markBody(PAL.dark)));
write("tesoro-mark-light.svg", svg(S, S, markBody(PAL.light)));
write("tesoro-mark-mono.svg", svg(S, S, `<path fill="currentColor" d="${MK.mono}"/>`));

// ---- wordmark: TESORO in chamfered caps, stroked with bevel joins so every outer corner is cut at 45° ----
// Units: cap height 100, stroke 20, bowl chamfer 18. Spacing is per letter pair (T sits tighter).
const WT = 20, CH = 100, C = 18, h = WT / 2;
const glyph = {
  T: (x) => [`M${x} ${h}H${x + 76}M${x + 38} ${h}V${CH}`, 76],
  E: (x) => [`M${x + 64} ${h}H${x + h}V${CH - h}H${x + 64}M${x + h} ${CH / 2}H${x + 56}`, 64],
  S: (x) => {
    const w = 70;
    return [`M${x + w} ${h}H${x + C + h}L${x + h} ${h + C}V${CH / 2 - C / 2}L${x + C / 2 + h} ${CH / 2}H${x + w - C / 2 - h}L${x + w - h} ${CH / 2 + C / 2}V${CH - h - C}L${x + w - C - h} ${CH - h}H${x}`, w];
  },
  O: (x) => {
    const w = 90, a = x + h, b = x + w - h, t = h, u = CH - h;
    return [`M${a + C} ${t}H${b - C}L${b} ${t + C}V${u - C}L${b - C} ${u}H${a + C}L${a} ${u - C}V${t + C}Z`, w];
  },
  R: (x) => {
    const w = 72;
    return [`M${x + h} ${CH}V${h}H${x + w - C - h}L${x + w - h} ${h + C}V${CH / 2 - C + 4}L${x + w - C - h} ${CH / 2 + 4}H${x + h}M${x + w - 30} ${CH / 2 + 4}L${x + w - h + 2} ${CH}`, w];
  },
};
const track = { TE: 12, ES: 22, SO: 22, OR: 22, RO: 22 };
let wx = 0;
const wparts = [];
[..."TESORO"].forEach((ch, i, a) => {
  const [dd, w] = glyph[ch](wx);
  wparts.push(dd);
  wx += w + (track[ch + a[i + 1]] ?? 0);
});
const WORD = { w: wx, h: CH, d: wparts.join(""), stroke: WT };
const wordGroup = (x, y, scale, color) =>
  `<g transform="translate(${x} ${y}) scale(${scale})"><path d="${WORD.d}" fill="none" stroke="${color}" stroke-width="${WT}" stroke-linejoin="bevel" stroke-linecap="butt"/></g>`;
write("tesoro-wordmark.svg", svg(WORD.w, CH, wordGroup(0, 0, 1, "currentColor")));

// horizontal: cap height 0.46 of the mark, gap 0.28; stacked: word 1.6 x the mark's width, gap 0.2
const hCap = 0.46 * S, hGap = 0.28 * S, hScale = hCap / CH, hW = Math.round(S + hGap + WORD.w * hScale);
const sScale = (1.6 * S) / WORD.w, sW = Math.round(WORD.w * sScale), sGap = 0.2 * S, sH = Math.round(S + sGap + CH * sScale);
for (const mode of ["dark", "light"]) {
  const p = PAL[mode];
  write(`tesoro-lockup-horizontal-${mode}.svg`, svg(hW, S, markBody(p) + wordGroup(S + hGap, (S - hCap) / 2, hScale, p.text)));
  write(`tesoro-lockup-stacked-${mode}.svg`, svg(sW, sH, `<g transform="translate(${(sW - S) / 2} 0)">${markBody(p)}</g>` + wordGroup(0, S + sGap, sScale, p.text)));
}

// shared data for the React component
const ts = `// Generated by app/scripts/build-brand.mjs. Do not edit by hand.
export const MARK = { size: ${S}, ...${JSON.stringify(MK)} } as const;
export const WORDMARK = ${JSON.stringify(WORD)} as const;
export const LOCKUP = { w: ${hW}, h: ${S}, gap: ${hGap}, capH: ${hCap} } as const;
export const PALETTE = ${JSON.stringify(PAL, null, 2)} as const;
`;
fs.writeFileSync(out("src/components/brand/paths.ts"), ts);

// ---- rasters, all rendered from the vector mark ----
const markSvg = Buffer.from(svg(S, S, markBody(PAL.dark)));
const markAt = (s) => sharp(markSvg, { density: 72 * (s / S) * 4 }).resize(s, s, { kernel: "lanczos3" }).png().toBuffer();
fs.writeFileSync(out("src/app/icon.png"), await markAt(192));
// app tile: the mark on the shell colour with a soft light from the upper left
const tile = async (s, frac) => {
  const bg = Buffer.from(svg(s, s, `<defs><radialGradient id="r" cx=".32" cy=".26" r=".85"><stop offset="0" stop-color="#1B2A25"/><stop offset=".7" stop-color="#0A0D0E"/></radialGradient></defs><rect width="${s}" height="${s}" fill="url(#r)"/>`));
  return sharp(bg).composite([{ input: await markAt(Math.round(s * frac)), gravity: "center" }]).png({ compressionLevel: 9 });
};
await (await tile(180, 0.6)).toFile(out("src/app/apple-icon.png"));
for (const s of [192, 512]) await (await tile(s, 0.6)).toFile(out(`public/icons/icon-${s}.png`));
const mask = await sharp({ create: { width: 512, height: 512, channels: 4, background: "#0C0E10" } })
  .composite([{ input: await markAt(300), gravity: "center" }]).png({ compressionLevel: 9 }).toBuffer();
fs.writeFileSync(out("public/icons/maskable-512.png"), mask);
// favicon.ico: PNG-in-ICO, 16 + 32 + 48
const sizes = [16, 32, 48];
const imgs = await Promise.all(sizes.map(markAt));
const head = Buffer.alloc(6 + 16 * imgs.length);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(imgs.length, 4);
let off = head.length;
imgs.forEach((b, i) => {
  const s = sizes[i], o = 6 + 16 * i;
  head[o] = s; head[o + 1] = s;
  head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
  head.writeUInt32LE(b.length, o + 8); head.writeUInt32LE(off, o + 12);
  off += b.length;
});
fs.writeFileSync(out("src/app/favicon.ico"), Buffer.concat([head, ...imgs]));

// ---- social card: the original game art on the right, lockup + headline set from vectors on the left ----
const fb = fs.readFileSync(fontFile);
const font = opentype.parse(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.length));
const lines = ["Play now with", "yield you haven’t", "earned yet."];
const OGX = 72, FS = 62, LH = 70, firstBase = 360;
const headline = lines.map((t, i) => font.getPath(t, OGX, firstBase + i * LH, FS, { kerning: true }).toPathData(1)).join("");
const ogLockH = 104, ogScale = ogLockH / S;
const og = svg(1200, 630,
  `<defs><linearGradient id="f" x1="0" x2="1"><stop offset="0" stop-color="#080B0F"/><stop offset=".505" stop-color="#080B0F"/><stop offset=".6" stop-color="#080B0F" stop-opacity="0"/></linearGradient></defs>` +
  `<rect width="1200" height="630" fill="url(#f)"/>` +
  `<g transform="translate(${OGX} 150) scale(${ogScale})">${markBody(PAL.dark)}${wordGroup(S + hGap, (S - hCap) / 2, hScale, PAL.dark.text)}</g>` +
  `<path fill="#F5F3EE" d="${headline}"/>`);
const ogPng = await sharp(path.join(SRC, "og-image.png")).resize(1200, 630).composite([{ input: Buffer.from(og) }]).png().toBuffer();
for (const n of ["opengraph-image", "twitter-image"])
  await sharp(ogPng).png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 }).toFile(out(`src/app/${n}.png`));
fs.writeFileSync(path.join(EXPORT, "og-image.png"), ogPng);
for (const s of [1024, 400]) await (await tile(s, 0.6)).toFile(path.join(EXPORT, s === 1024 ? "app-icon.png" : "x-avatar.png"));
console.log("ok", { hW, sW, sH, word: WORD.w });
