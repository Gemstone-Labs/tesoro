import { PublicKey } from "@solana/web3.js";
import { supabaseRpc } from "@/server/history/db";
import { endStateOf } from "@/server/history/end-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The public end state of a finished table Match (board, picks, scores), by its Match address. 404 when none was captured. Public, read-only. */
export async function GET(_req: Request, { params }: { params: Promise<{ match: string }> }) {
  const raw = (await params).match;
  let match: string;
  try {
    match = new PublicKey(raw).toBase58();
  } catch {
    return Response.json({ error: "Not a Match address." }, { status: 400 });
  }
  try {
    const stored = await endStateOf(supabaseRpc, match);
    if (!stored) return Response.json({ error: "No end state was kept for this Match." }, { status: 404, headers: { "cache-control": "public, s-maxage=30" } });
    return Response.json(stored, { headers: { "cache-control": "public, s-maxage=600, stale-while-revalidate=3600" } });
  } catch (e) {
    console.error("end state", e);
    return Response.json({ error: "Match history is not available." }, { status: 503 });
  }
}
