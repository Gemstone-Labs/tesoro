// Imports Astra's final art from the workspace (outside the repo) into public/art/final as WebP.
import sharp from "sharp";
import { mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.ART_SRC ?? resolve(here, "../../../art-source/ui-redesign/assets");
const OUT = resolve(here, "../public/art/final");
const POSES = process.env.POSES_SRC ?? resolve(here, "../../../art-source/ui-redesign/character/poses");
const POSES_OUT = resolve(here, "../public/art/final/characters");
const width = (name) => (name.endsWith("-hero") ? 2400 : name.startsWith("avatar-") ? 256 : 768);

for (const file of readdirSync(SRC).filter((f) => f.endsWith(".png"))) {
  const name = file.replace(/\.png$/, "");
  await sharp(resolve(SRC, file)).resize({ width: width(name) }).webp({ quality: 84 }).toFile(resolve(OUT, `${name}.webp`));
  console.log(name);
}

mkdirSync(POSES_OUT, { recursive: true });
for (const file of readdirSync(POSES).filter((f) => f.endsWith(".png"))) {
  const name = file.replace(/\.png$/, "");
  await sharp(resolve(POSES, file)).resize({ width: name.startsWith("duo-") ? 1200 : 640 }).webp({ quality: 86, alphaQuality: 90 }).toFile(resolve(POSES_OUT, `${name}.webp`));
  console.log(`characters/${name}`);
}
