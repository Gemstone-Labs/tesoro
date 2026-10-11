import { parseSpot } from "@/lib/waitlist-spot";
import { CARD_VARIANTS, type CardVariant } from "@/components/waitlist/SpotCard";
import { spotCard } from "@/server/spot-card";

/** Prototype only: every card look for one spot, `?v=A|A1|A2|A3`. Removed once a look is picked. */
export async function GET(req: Request, { params }: { params: Promise<{ spot: string }> }) {
  const spot = parseSpot((await params).spot);
  if (!spot) return new Response("Not found", { status: 404 });
  const v = new URL(req.url).searchParams.get("v");
  return spotCard(spot, CARD_VARIANTS.includes(v as CardVariant) ? (v as CardVariant) : "A");
}
