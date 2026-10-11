import { getLeaderboard } from "@/server/leaderboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** This season's standings, the pool and the last season's winners (see server/leaderboard.ts). Public, read-only. `?me=<Account>` adds that Account's row. */
export async function GET(req: Request) {
  const me = new URL(req.url).searchParams.get("me");
  try {
    return Response.json(await getLeaderboard(me && ACCOUNT.test(me) ? me : null), { headers: { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" } });
  } catch (e) {
    console.error("leaderboard", e);
    return Response.json({ error: "Couldn’t load the leaderboard." }, { status: 502 });
  }
}
