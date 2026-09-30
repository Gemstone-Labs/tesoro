/**
 * PLACEHOLDER ART. Crops game art out of the approved mockup (take-1.png) until the real assets
 * land in art-source/ui-redesign/assets/. Output: app/public/art/placeholder/*.png, referenced only
 * through src/lib/art.ts, so swapping to final art is one line per image.
 *
 *   TAKE1=/path/to/take-1.png node scripts/crop-placeholder-art.mjs
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.TAKE1 ?? resolve(here, "../../art-source/ui-redesign/lobby-desktop/take-1.png");
if (!existsSync(SRC)) throw new Error(`take-1.png not found at ${SRC}; set TAKE1=`);
const OUT = resolve(here, "../public/art/placeholder");
mkdirSync(OUT, { recursive: true });

const BG = { r: 12, g: 17, b: 21, alpha: 1 };
const SCALE = 2;

/** Crop a rectangle (x, y, w, h) of take-1, upscale 2x, save. `pad` fades the crop into a dark canvas of the given size. */
async function crop(name, [x, y, w, h], pad) {
  let img = sharp(SRC).extract({ left: x, top: y, width: w, height: h }).resize(w * SCALE, h * SCALE, { kernel: "lanczos3" });
  if (pad) {
    const [cw, ch] = pad.canvas;
    const fadeFrom = Math.round(h * SCALE * 0.5);
    const fade = Buffer.from(
      `<svg width="${w * SCALE}" height="${h * SCALE}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="${fadeFrom / (h * SCALE)}" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`,
    );
    const masked = await img.ensureAlpha().composite([{ input: await sharp(fade).png().toBuffer(), blend: "dest-in" }]).png().toBuffer();
    img = sharp({ create: { width: cw * SCALE, height: ch * SCALE, channels: 4, background: BG } }).composite([{ input: masked, left: 0, top: 0 }]);
  }
  await img.png({ compressionLevel: 9 }).toFile(`${OUT}/${name}.png`);
  console.log("wrote", name);
}

// Hero and rail art. Baked labels in take-1 (titles, "Coming soon") are cropped off; the app draws its own.
await crop("block-puzzle-hero", [846, 155, 664, 299]);
await crop("holdem-hero", [1534, 285, 380, 170]);
// Tiles are 250x207 in take-1; art only (labels at the bottom are excluded and padded with the shell colour).
const TILE_CANVAS = [246, 203];
const tileX = [295, 563, 831, 1097, 1365, 1633];
await crop("block-puzzle-tile", [tileX[0], 544, 246, 160], { canvas: TILE_CANVAS });
await crop("holdem-tile", [tileX[1], 544, 246, 160], { canvas: TILE_CANVAS });
await crop("coming-soon-word-duel", [tileX[2], 544, 246, 116], { canvas: TILE_CANVAS });
await crop("coming-soon-bubble-burst", [tileX[3], 544, 246, 116], { canvas: TILE_CANVAS });
await crop("coming-soon-pocket-pool", [tileX[4], 544, 246, 116], { canvas: TILE_CANVAS });
await crop("coming-soon-trivia-sprint", [tileX[5], 544, 246, 116], { canvas: TILE_CANVAS });
// Play Again thumbnails (landscape).
await crop("block-puzzle-thumb", [295, 819, 132, 88]);
await crop("holdem-thumb", [688, 819, 136, 88]);
// Avatars (Dana, Alex, Mika).
await crop("avatar-1", [312, 1035, 62, 62]);
await crop("avatar-2", [846, 1035, 62, 62]);
await crop("avatar-3", [1373, 1035, 62, 62]);
