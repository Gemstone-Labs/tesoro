import { getLeaderboard } from "@/server/leaderboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** This season's standings, the pool and the last season's winners (see server/leaderboard.ts). Public, read-only. */
export async function GET() {
  try {
    return Response.json(await getLeaderboard(), { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" } });
  } catch (e) {
    console.error("leaderboard", e);
    return Response.json({ error: "Couldn’t load the leaderboard." }, { status: 502 });
  }
}
