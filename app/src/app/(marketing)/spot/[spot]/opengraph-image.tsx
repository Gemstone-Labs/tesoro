import { notFound } from "next/navigation";
import { parseSpotSlug } from "@/lib/waitlist-spot";
import { CARD, spotCard } from "@/server/spot-card";

export const size = CARD;
export const contentType = "image/png";
export const alt = "A Tesoro waitlist spot and its gemstone animal";

export default async function Image({ params }: { params: Promise<{ spot: string }> }) {
  const slug = parseSpotSlug((await params).spot);
  if (!slug) notFound();
  return spotCard(slug.spot, slug.roles);
}
