/**
 * Torso-up ("bust") crops of the full-body character poses: trims the transparent margin, keeps the
 * top part of the figure (cut at the waist) and writes public/art/final/characters/bust/<name>.webp.
 * Full-body art is never shown in the app (DESIGN.md, Character placement); only these crops are.
 *
 *   node scripts/make-busts.mjs
 */
import sharp from "sharp";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public/art/final/characters");
const OUT = `${DIR}/bust`;
mkdirSync(OUT, { recursive: true });

/** Fraction of the trimmed figure's height that is kept from the top (waist or chest line). */
const KEEP = { "her-backing": 0.56, "her-empty": 0.5, "her-waiting-crosschain": 0.52, "him-explain": 0.52, "him-lose": 0.5, "him-waiting": 0.5, "him-welcome": 0.52, "him-win": 0.52, "duo-hero": 0.55, "duo-win": 0.55 };

const montage = process.argv[2];
const tiles = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".webp"))) {
  const name = f.replace(".webp", "");
  const trimmed = await sharp(`${DIR}/${f}`).trim({ threshold: 10 }).toBuffer({ resolveWithObject: true });
  const { width, height } = trimmed.info;
  const h = Math.round(height * (KEEP[name] ?? 0.52));
  const buf = await sharp(trimmed.data).extract({ left: 0, top: 0, width, height: h }).webp({ quality: 88, alphaQuality: 95 }).toBuffer();
  await sharp(buf).toFile(`${OUT}/${f}`);
  console.log(name, `${width}x${h}`);
  tiles.push(buf);
}
if (montage) {
  const comp = [];
  for (const [i, b] of tiles.entries()) {
    comp.push({ input: await sharp(b).resize(300, 300, { fit: "contain", background: "#222" }).flatten({ background: "#222" }).png().toBuffer(), left: (i % 5) * 300, top: Math.floor(i / 5) * 300 });
  }
  await sharp({ create: { width: 1500, height: 600, channels: 3, background: "#222" } }).composite(comp).png().toFile(montage);
}
