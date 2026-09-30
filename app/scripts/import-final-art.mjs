// Imports Astra's final art from the workspace (outside the repo) into public/art/final as WebP.
import sharp from "sharp";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.ART_SRC ?? resolve(here, "../../../art-source/ui-redesign/assets");
const OUT = resolve(here, "../public/art/final");
const width = (name) => (name.endsWith("-hero") ? 2400 : name.startsWith("avatar-") ? 256 : 768);

for (const file of readdirSync(SRC).filter((f) => f.endsWith(".png"))) {
  const name = file.replace(/\.png$/, "");
  await sharp(resolve(SRC, file)).resize({ width: width(name) }).webp({ quality: 84 }).toFile(resolve(OUT, `${name}.webp`));
  console.log(name);
}
