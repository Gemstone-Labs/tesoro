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
const isAvatar = (name) => /^avatar-\d+$/.test(name);
const width = (name) => (name.endsWith("-hero") || name.endsWith("-banner") ? 2400 : isAvatar(name) ? 256 : 768);
// Avatars are drawn with a wide dark margin; keep the central 84% so the head reads at 28px.
const AVATAR_CROP = 0.84;
// Avatars live in their own folder: the image optimizer caches by URL, so a new set needs new URLs.
const AVATARS_OUT = resolve(OUT, "avatars");
mkdirSync(AVATARS_OUT, { recursive: true });

// Contact sheets and review takes (`-take-N`) stay in art-source.
for (const file of readdirSync(SRC).filter((f) => f.endsWith(".png") && !f.endsWith("-contact-sheet.png") && !/-take-\d+\.png$/.test(f))) {
  const name = file.replace(/\.png$/, "");
  let img = sharp(resolve(SRC, file));
  if (isAvatar(name)) {
    const { width: w, height: h } = await img.metadata();
    const side = Math.round(Math.min(w, h) * AVATAR_CROP);
    img = img.extract({ left: Math.round((w - side) / 2), top: Math.round((h - side) / 2), width: side, height: side });
  }
  await img.resize({ width: width(name) }).webp({ quality: 84 }).toFile(resolve(isAvatar(name) ? AVATARS_OUT : OUT, `${name}.webp`));
  console.log(name);
}

mkdirSync(POSES_OUT, { recursive: true });
for (const file of readdirSync(POSES).filter((f) => f.endsWith(".png"))) {
  const name = file.replace(/\.png$/, "");
  await sharp(resolve(POSES, file)).resize({ width: name.startsWith("duo-") ? 1200 : 640 }).webp({ quality: 86, alphaQuality: 90 }).toFile(resolve(POSES_OUT, `${name}.webp`));
  console.log(`characters/${name}`);
}
