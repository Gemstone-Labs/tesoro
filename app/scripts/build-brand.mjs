/**
 * Builds the Tesoro brand vectors from geometry (no auto-trace): mark SVGs, lockups with outlined
 * wordmark, shared path data for the React component, and the icon rasters.
 * Needs `opentype.js`, `sharp` and `@fontsource/schibsted-grotesk` resolvable from BRAND_DEPS
 * (path to a package.json that has them installed):
 *   BRAND_DEPS=/path/to/package.json node app/scripts/build-brand.mjs
 * Sources: art-source/ui-redesign/brand/{app-icon,og-image}.png (outside the repo).
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
const SRC = process.env.BRAND_SRC ?? path.join(process.env.HOME, "Work/gemstone-labs/tesoro/art-source/ui-redesign/brand");
const EXPORT = path.join(SRC, "export");
const out = (p) => path.join(app, p);
for (const d of [out("public/brand"), out("public/icons"), out("src/components/brand"), EXPORT]) fs.mkdirSync(d, { recursive: true });

// ---- geometry, in the source's coordinates, mirrored about x = 966 ----
const OX = 192, OY = 204, W = 1548, H = 1558;
const mir = (pts) => pts.map(([x, y]) => [1932 - x, y]).reverse();
const d = (pts) => "M" + pts.map(([x, y]) => `${x - OX} ${y - OY}`).join("L") + "Z";
const pair = (pts) => [pts, mir(pts)];

const facets = {
  light: [
    [[620, 204], [1312, 204], [1232, 383], [700, 383]],
    [[760, 1527], [1172, 1527], [1312, 1762], [620, 1762]],
    [[720, 425], [1212, 425], [1340, 553], [598, 553]],
    ...pair([[500, 822], [790, 822], [790, 1012], [490, 838]]),
  ],
  mid: [
    ...pair([[620, 204], [700, 383], [380, 703], [203, 620]]),
    ...pair([[455, 1245], [735, 1522], [612, 1750], [207, 1350]]),
    [[598, 553], [1340, 553], [1510, 735], [1430, 785], [1105, 785], [1105, 1483], [827, 1483], [827, 785], [505, 785], [418, 735]],
  ],
  dark: [
    ...pair([[192, 648], [458, 808], [458, 1195], [192, 1335]]),
    ...pair([[490, 838], [790, 1012], [790, 1483], [772, 1483], [490, 1195]]),
  ],
};
const octagon = [[620, 204], [1312, 204], [1732, 624], [1732, 1340], [1312, 1762], [620, 1762], [200, 1340], [200, 624]];
const simpleT = [[430, 470], [1502, 470], [1502, 720], [1122, 720], [1122, 1500], [810, 1500], [810, 720], [430, 720]];

const dp = Object.fromEntries(Object.entries(facets).map(([k, v]) => [k, v.map(d).join("")]));
const octD = d(octagon), tD = d(simpleT);

// ---- palettes ----
const PAL = {
  dark: { light: ["#A4FADD", "#7EF0C8"], mid: ["#38CB98", "#2AB786"], dark: ["#0E7D5A", "#0A6549"], text: "#F5F3EE" },
  light: { light: ["#2CC593", "#1FB283"], mid: ["#17A374", "#0F8F65"], dark: ["#0A6146", "#07503A"], text: "#0C0E10" },
};
const grad = (id, [a, b]) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
const defs = (p, pre) => grad(pre + "l", p.light) + grad(pre + "m", p.mid) + grad(pre + "d", p.dark);
const fullBody = (pre) => `<path fill="url(#${pre}d)" d="${dp.dark}"/><path fill="url(#${pre}m)" d="${dp.mid}"/><path fill="url(#${pre}l)" d="${dp.light}"/>`;
const monoBody = `<path fill="currentColor" fill-opacity=".45" d="${dp.dark}"/><path fill="currentColor" fill-opacity=".75" d="${dp.mid}"/><path fill="currentColor" d="${dp.light}"/>`;
const svg = (w, h, inner, title) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}">${inner}</svg>\n`;
const write = (name, s) => { fs.writeFileSync(out("public/brand/" + name), s); fs.writeFileSync(path.join(EXPORT, name), s); };

write("tesoro-mark.svg", svg(W, H, `<defs>${defs(PAL.dark, "g")}</defs>${fullBody("g")}`, "Tesoro"));
write("tesoro-mark-mono.svg", svg(W, H, monoBody, "Tesoro"));
const markSimple = svg(W, H, `<defs>${grad("gm", PAL.dark.mid)}</defs><path fill="url(#gm)" d="${octD}"/><path fill="#06231B" d="${tD}"/>`, "Tesoro");
write("tesoro-mark-simple.svg", markSimple);

// ---- wordmark outlines ----
const fb = fs.readFileSync(fontFile);
const font = opentype.parse(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.length));
const FS = 1000, LS = -0.02;
const wp = font.getPath("Tesoro", 0, 0, FS, { letterSpacing: LS, kerning: true });
const bb = wp.getBoundingBox();
const capH = -font.getPath("T", 0, 0, FS).getBoundingBox().y1;
const r = (n) => Math.round(n * 10) / 10;
const shifted = (x, y, scale) => {
  const p = new opentype.Path();
  for (const c of wp.commands) {
    const m = { ...c };
    for (const k of ["x", "x1", "x2"]) if (k in m) m[k] = r((m[k] - bb.x1) * scale + x);
    for (const k of ["y", "y1", "y2"]) if (k in m) m[k] = r(m[k] * scale + y);
    p.commands.push(m);
  }
  return p.toPathData(1);
};
const textW = bb.x2 - bb.x1;

// horizontal: cap height 0.67 of mark height, gap 0.16 H
const hs = (0.67 * H) / capH, hx = W + 0.16 * H, hW = Math.round(hx + textW * hs), hBase = H / 2 + (capH * hs) / 2;
const hWord = shifted(hx, hBase, hs);
// stacked: text width 1.3 x mark width
const ss = (1.3 * W) / textW, sW = Math.round(textW * ss), gap = 0.16 * H, sBase = H + gap + capH * ss, sH = Math.round(sBase + 0.05 * capH * ss);
const sWord = shifted(0, sBase, ss);
for (const mode of ["dark", "light"]) {
  const p = PAL[mode], pre = mode[0];
  const hd = `<defs>${defs(p, pre)}</defs>`;
  write(`tesoro-lockup-horizontal-${mode}.svg`, svg(hW, H, `${hd}${fullBody(pre)}<path fill="${p.text}" d="${hWord}"/>`, "Tesoro"));
  write(`tesoro-lockup-stacked-${mode}.svg`, svg(sW, sH, `${hd}<g transform="translate(${r((sW - W) / 2)} 0)">${fullBody(pre)}</g><path fill="${p.text}" d="${sWord}"/>`, "Tesoro"));
}

// shared data for the React component
const ts = `// Generated by app/scripts/build-brand.mjs. Do not edit by hand.
export const MARK = { w: ${W}, h: ${H}, dark: "${dp.dark}", mid: "${dp.mid}", light: "${dp.light}", octagon: "${octD}", t: "${tD}" } as const;
export const WORDMARK = { w: ${Math.round(textW * hs)}, capH: ${r(capH * hs)}, path: "${shifted(0, capH * hs, hs)}" } as const;
export const LOCKUP = { w: ${hW}, h: ${H}, gap: ${r(0.16 * H)} } as const;
export const PALETTE = ${JSON.stringify(PAL, null, 2)} as const;
`;
fs.writeFileSync(out("src/components/brand/paths.ts"), ts);

// ---- rasters ----
// Site and app icons are the Gema itself (founder, Oct 1), cut from the approved Astra art: the octagon is masked out
// of its frame so the rays behind it drop away.
const GEMA_ART = process.env.GEMA_SRC ?? path.join(SRC, "../../pitch/flow-steps/step-4-match/native/take-1.png");
const GEMA_CROP = { left: 524, top: 543, width: 204, height: 175 };
const GEMA_OUTLINE = "48,2 156,2 202,49 201.5,127 156,173.5 46.5,173 1.5,127.5 1.5,49";
const gemaMask = `<svg xmlns="http://www.w3.org/2000/svg" width="${GEMA_CROP.width}" height="${GEMA_CROP.height}"><polygon points="${GEMA_OUTLINE}" fill="#fff"/></svg>`;
const gemaCut = await sharp(GEMA_ART).extract(GEMA_CROP).ensureAlpha()
  .composite([{ input: Buffer.from(gemaMask), blend: "dest-in" }]).png().toBuffer();
const clear = { r: 0, g: 0, b: 0, alpha: 0 };
const gema = await sharp(gemaCut).extend({ top: 18, bottom: 19, left: 4, right: 4, background: clear }).png().toBuffer();
const gemaAt = (s) => sharp(gema).resize(s, s, { fit: "contain", background: clear, kernel: "lanczos3" }).png().toBuffer();
const onBg = async (size, inner) => sharp({ create: { width: size, height: size, channels: 4, background: "#0C0E10" } })
  .composite([{ input: await gemaAt(inner), gravity: "center" }]).png({ compressionLevel: 9 }).toBuffer();
fs.writeFileSync(out("src/app/icon.png"), await gemaAt(192));
fs.writeFileSync(out("src/app/apple-icon.png"), await onBg(180, 132));
fs.writeFileSync(out("public/icons/icon-192.png"), await onBg(192, 150));
fs.writeFileSync(out("public/icons/icon-512.png"), await onBg(512, 400));
fs.writeFileSync(out("public/icons/maskable-512.png"), await onBg(512, 300));
// favicon.ico: PNG-in-ICO, 16 + 32 + 48
const sizes = [16, 32, 48];
const imgs = await Promise.all(sizes.map(gemaAt));
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
// social
for (const n of ["opengraph-image", "twitter-image"])
  await sharp(path.join(SRC, "og-image.png")).png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 }).toFile(out(`src/app/${n}.png`));
// export copies
for (const f of ["mark-take-2.png", "mark-take-2-mono.png", "lockup-take-1.png", "lockup-take-1-stacked.png", "app-icon.png", "og-image.png", "x-avatar.png", "x-banner.png"])
  fs.copyFileSync(path.join(SRC, f), path.join(EXPORT, f));
console.log("ok", { hW, sW, sH });
