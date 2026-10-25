import { supabaseRpc } from "@/server/history/db";
import { playerForms } from "@/server/history/reads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_PLAYERS = 100;

/** Each listed Player's real record for the Backing board: `?players=<key>,<key>`. Public, read-only. */
export async function GET(req: Request) {
  const players = [...new Set((new URL(req.url).searchParams.get("players") ?? "").split(",").filter(Boolean))];
  if (players.length > MAX_PLAYERS || !players.every((p) => ACCOUNT.test(p))) return Response.json({ error: "Bad player list." }, { status: 400 });
  try {
    return Response.json(Object.fromEntries(await playerForms(supabaseRpc, players)), { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } });
  } catch (e) {
    console.error("player forms", e);
    return Response.json({ error: "Match history is not available." }, { status: 503 });
  }
}
