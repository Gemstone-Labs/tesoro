/** Side-by-side of each approved mockup (left) and the build (right): docs/screens/p2-compare-{result,wallet,backing}.png */
import sharp from "sharp";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const art = process.env.ART ?? resolve(homedir(), "Work/gemstone-labs/tesoro/art-source/ui-redesign");
const pairs = [
  ["result", "result-won-desktop", "result-won"],
  ["wallet", "wallet-desktop", "wallet"],
  ["backing", "backing-desktop", "backing-offer"],
];
for (const [name, dir, shot] of pairs) {
  await sharp({ create: { width: 3860, height: 1200, channels: 3, background: "#ffffff" } })
    .composite([
      { input: resolve(art, dir, "take-1.png"), left: 0, top: 0 },
      { input: resolve(here, `../docs/screens/p2-${shot}-1920.png`), left: 1940, top: 0 },
    ])
    .png()
    .toFile(resolve(here, `../docs/screens/p2-compare-${name}.png`));
  console.log("wrote", name);
}
