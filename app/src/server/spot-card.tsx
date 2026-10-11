import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { CARD, SHARE_CARD, SpotCard, type CardVariant } from "@/components/waitlist/SpotCard";
import { gemFor } from "@/lib/waitlist-spot";

export { CARD, type CardVariant };

const asset = (name: string) => readFile(join(process.cwd(), "assets/share", name));

async function fonts() {
  const [display, bold, regular] = await Promise.all([
    asset("BarlowCondensed-800.ttf"),
    asset("SchibstedGrotesk-700.ttf"),
    asset("SchibstedGrotesk-400.ttf"),
  ]);
  return [
    { name: "Display", data: display, weight: 800 as const, style: "normal" as const },
    { name: "Sans", data: bold, weight: 700 as const, style: "normal" as const },
    { name: "Sans", data: regular, weight: 400 as const, style: "normal" as const },
  ];
}

export async function spotCard(spot: number, variant: CardVariant = SHARE_CARD): Promise<ImageResponse> {
  const gem = gemFor(spot);
  const [img, f] = await Promise.all([asset(`avatar-${gem.avatar}.jpg`), fonts()]);
  const src = `data:image/jpeg;base64,${img.toString("base64")}`;
  return new ImageResponse(<SpotCard gem={gem} src={src} variant={variant} />, { ...CARD, fonts: f });
}
