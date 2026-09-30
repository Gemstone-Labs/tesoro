import { GpaInputError, GpaUpstreamError, getAccounts, parseQuery, retryAfterSecs } from "@/server/gpa";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * List query for one of our programs (getProgramAccounts on TESORO_GPA_RPC), cached in-process so
 * every tab shares one upstream call. Returns base64 account data. See app/docs/rpc.md.
 */
export async function GET(request: Request) {
  try {
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
