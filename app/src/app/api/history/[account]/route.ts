import { supabaseRpc } from "@/server/history/db";
import { HISTORY_PAGE_SIZE, accountHistory } from "@/server/history/reads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const GAMES = new Set(["block-puzzle", "holdem", "trading-duel", "vanguard"]);

const ALL_PAGE = 200;
const ALL_MAX_PAGES = 10;

/**
 * One page of an Account's finished Matches (played and funded), newest first: `?page=` (1-based) and `?game=` (a Game id).
 * `?all=1` returns up to 2,000 of the newest rows in one answer (the Account page's totals and chart). Public, read-only.
 */
export async function GET(req: Request, { params }: { params: Promise<{ account: string }> }) {
  const { account } = await params;
  if (!ACCOUNT.test(account)) return Response.json({ error: "Not an Account key." }, { status: 400 });
  const q = new URL(req.url).searchParams;
  const page = Math.max(1, Math.floor(Number(q.get("page"))) || 1);
  const game = q.get("game");
  if (game && !GAMES.has(game)) return Response.json({ error: "Unknown Game." }, { status: 400 });
  try {
    if (q.get("all") === "1") {
      const first = await accountHistory(supabaseRpc, account, 1, ALL_PAGE, game);
      const rows = [...first.rows];
      for (let p = 2; p <= Math.min(first.pages, ALL_MAX_PAGES); p++) rows.push(...(await accountHistory(supabaseRpc, account, p, ALL_PAGE, game)).rows);
      return Response.json({ rows, page: 1, pages: 1, total: first.total }, { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=60" } });
    }
    return Response.json(await accountHistory(supabaseRpc, account, page, HISTORY_PAGE_SIZE, game), { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=60" } });
  } catch (e) {
    console.error("account history", e);
    return Response.json({ error: "Match history is not available." }, { status: 503 });
  }
}
