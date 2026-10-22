import { supabaseRpc } from "@/server/history/db";
import { recentWins } from "@/server/history/reads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GAMES = new Set(["block-puzzle", "holdem", "trading-duel", "vanguard"]);

/** The newest settled Matches with a winner (the Lobby ticker): `?game=`, `?since=` (ms), `?limit=` (1-200). Public, read-only. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const game = q.get("game");
  if (game && !GAMES.has(game)) return Response.json({ error: "Unknown Game." }, { status: 400 });
  const since = q.get("since");
  const limit = Math.min(200, Math.max(1, Math.floor(Number(q.get("limit"))) || 8));
  try {
    const wins = await recentWins(supabaseRpc, { game: game ?? undefined, since: since && Number(since) > 0 ? Math.floor(Number(since)) : undefined, limit });
    return Response.json(wins, { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=60" } });
  } catch (e) {
    console.error("recent wins", e);
    return Response.json({ error: "Match history is not available." }, { status: 503 });
  }
}
