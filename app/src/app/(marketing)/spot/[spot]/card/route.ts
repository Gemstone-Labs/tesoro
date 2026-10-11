import { parseSpot } from "@/lib/waitlist-spot";
import { spotCard, type CardVariant } from "@/server/spot-card";

/** Prototype only: every card look for one spot, `?v=A|B|C`. Removed once a look is picked. */
export async function GET(req: Request, { params }: { params: Promise<{ spot: string }> }) {
  const spot = parseSpot((await params).spot);
  if (!spot) return new Response("Not found", { status: 404 });
  const v = new URL(req.url).searchParams.get("v");
  return spotCard(spot, v === "B" || v === "C" ? (v as CardVariant) : "A");
}
