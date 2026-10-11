/**
 * Large torso-up crops for the Guide overlay, cut from Astra's native 1254px poses (the in-app busts
 * in characters/bust/ are cut from 640px art and too small to show big). Writes
 * public/art/final/characters/guide/<name>.webp at 900px wide.
 *
 *   node scripts/make-guide-busts.mjs [poses dir, default the workspace art-source]
 */
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = process.argv[2] ?? `${homedir()}/Work/gemstone-labs/tesoro/art-source/ui-redesign/character/poses/native`;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/art/final/characters/guide");
mkdirSync(OUT, { recursive: true });

/** Fraction of the trimmed figure's height kept from the top: a little below the waist, so the fade has room. */
const KEEP = { "him-welcome": 0.6, "him-explain": 0.6, "him-lose": 0.6, "her-backing": 0.62, "her-waiting-crosschain": 0.6 };

for (const [name, keep] of Object.entries(KEEP)) {
  const trimmed = await sharp(`${SRC}/${name}.png`).trim({ threshold: 10 }).toBuffer({ resolveWithObject: true });
  const { width, height } = trimmed.info;
  const h = Math.round(height * keep);
  const info = await sharp(trimmed.data).extract({ left: 0, top: 0, width, height: h }).resize({ width: 900 }).webp({ quality: 86, alphaQuality: 95 }).toFile(`${OUT}/${name}.webp`);
  console.log(name, `${info.width}x${info.height}`);
}
