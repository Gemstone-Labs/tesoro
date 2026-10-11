import { notFound } from "next/navigation";
import { parseSpot } from "@/lib/waitlist-spot";
import { CARD, spotCard } from "@/server/spot-card";

export const size = CARD;
export const contentType = "image/png";
export const alt = "A Tesoro waitlist spot and its gemstone animal";

export default async function Image({ params }: { params: Promise<{ spot: string }> }) {
  const spot = parseSpot((await params).spot);
  if (!spot) notFound();
  return spotCard(spot);
}
