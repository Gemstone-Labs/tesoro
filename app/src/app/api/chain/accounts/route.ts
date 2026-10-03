import { GpaInputError, GpaUpstreamError, clientKey, getAccounts, parseQuery, retryAfterSecs, takeClient } from "@/server/gpa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Upstream calls time out at 20 s: a request still running at 30 s is hung, not slow (Vercel's default let one run 300 s). */
export const maxDuration = 30;

/**
 * List query for tesoro_core (getProgramAccounts on TESORO_GPA_RPC), cached in-process so every tab
 * shares one upstream call. Only the query shapes the app uses are accepted. See app/docs/rpc.md.
 */
export async function GET(request: Request) {
  try {
    if (!takeClient(clientKey(request.headers))) {
      return Response.json({ error: "Too many list queries." }, { status: 429, headers: { "retry-after": "60" } });
    }
    const q = parseQuery(new URL(request.url).searchParams);
    return Response.json(await getAccounts(q), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof GpaInputError) return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof GpaUpstreamError) {
      const limited = e.status === 429;
      return Response.json({ error: e.message }, { status: limited ? 503 : 502, headers: limited ? { "retry-after": String(retryAfterSecs()) } : {} });
    }
    console.error("chain/accounts", e);
    return Response.json({ error: "List query failed." }, { status: 500 });
  }
}
