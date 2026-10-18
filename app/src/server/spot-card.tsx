import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { CARD, SpotCard } from "@/components/waitlist/SpotCard";
import { WinCard } from "@/components/win/WinCard";
import { roleTags, type Role } from "@/lib/waitlist-role";
import { gemFor } from "@/lib/waitlist-spot";
import type { WinCardData } from "@/lib/win-card";

export { CARD };

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

export async function spotCard(spot: number, roles: readonly Role[] = []): Promise<ImageResponse> {
  const gem = gemFor(spot);
  const [img, f] = await Promise.all([asset(`avatar-${gem.avatar}.jpg`), fonts()]);
  const src = `data:image/jpeg;base64,${img.toString("base64")}`;
  return new ImageResponse(<SpotCard gem={gem} src={src} tags={roleTags(roles)} />, { ...CARD, fonts: f });
}

export async function winCard(win: WinCardData): Promise<ImageResponse> {
  const [img, f] = await Promise.all([asset(`avatar-${win.avatar}.jpg`), fonts()]);
  const src = `data:image/jpeg;base64,${img.toString("base64")}`;
  return new ImageResponse(<WinCard win={win} src={src} />, { ...CARD, fonts: f });
}
