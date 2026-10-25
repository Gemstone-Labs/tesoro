import { supabaseRpc } from "@/server/history/db";
import { featuredGames } from "@/server/listing/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Games the Lobby and catalogue may feature. Public, read-only; an empty list when storage is down. */
export async function GET() {
  try {
    return Response.json(await featuredGames(supabaseRpc), { headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch (e) {
    console.error("featured games", e);
    return Response.json([], { headers: { "cache-control": "no-store" } });
  }
}
