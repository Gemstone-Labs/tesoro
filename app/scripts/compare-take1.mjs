/** Side-by-side of the approved mockup and the running Lobby at 1920: docs/screens/redesign-compare.png */
import sharp from "sharp";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const take1 = process.env.TAKE1 ?? resolve(here, "../../../art-source/ui-redesign/lobby-desktop/take-1.png");
const mine = resolve(here, "../docs/screens/redesign-lobby-1920-signedin.png");
await sharp({ create: { width: 3860, height: 1200, channels: 3, background: "#ffffff" } })
  .composite([
    { input: take1, left: 0, top: 0 },
    { input: mine, left: 1940, top: 0 },
  ])
  .png()
  .toFile(resolve(here, "../docs/screens/redesign-compare.png"));
console.log("wrote redesign-compare.png (left: take-1, right: build)");
