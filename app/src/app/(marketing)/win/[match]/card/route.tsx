import { notFound } from "next/navigation";
import { parseWinKey } from "@/lib/win-card";
import { winCard } from "@/server/spot-card";
import { loadWin } from "@/server/win-card";

/** The X card of a won Match: 404 for any Match that is not settled with a winner. */
export async function GET(_req: Request, { params }: { params: Promise<{ match: string }> }) {
  const id = parseWinKey((await params).match);
  const win = id === null ? null : await loadWin(id);
  if (!win) notFound();
  const image = await winCard(win);
  image.headers.set("cache-control", "public, max-age=3600, s-maxage=86400");
  return image;
}
