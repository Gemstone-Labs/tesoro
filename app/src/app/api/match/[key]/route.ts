import { parseMatchKey } from "@/server/history/match-key";
import { supabaseRpc } from "@/server/history/db";
import { matchPage } from "@/server/history/reads";
import { isGameId } from "@/lib/games";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The history record of a Match whose account is closed (result, sides, Fees, scores). Public, read-only. */
export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const id = parseMatchKey((await params).key);
  if (!id) return Response.json({ error: "Not a Match key." }, { status: 400 });
  try {
    const page = await matchPage(supabaseRpc, id);
    if (!page || !isGameId(page.game)) return Response.json({ error: "Unknown Match." }, { status: 404 });
    return Response.json(page, { headers: { "cache-control": page.status === "settled" || page.status === "refunded" ? "public, s-maxage=60, stale-while-revalidate=600" : "no-store" } });
  } catch (e) {
    console.error("match history", e);
    return Response.json({ error: "Match history is not available." }, { status: 503 });
  }
}
