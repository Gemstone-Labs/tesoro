import { PublicKey } from "@solana/web3.js";
import { GpaUpstreamError, clientKey, retryAfterSecs, takeClient } from "@/server/gpa";
import { getAccountState } from "@/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The browser falls back to its own read after 15 s; the server gives up first. */
export const maxDuration = 30;

/**
 * One Account's state (Holdings, Positions, Gemas, simSOL market) assembled on the server: the lists
 * come from the shared list cache and the rest from a few batched reads. Public, read-only, like the
 * chain it mirrors. `?fresh=1` after a transaction the Account sent: the lists are re-read first.
 */
export async function GET(request: Request, { params }: { params: Promise<{ authority: string }> }) {
  const { authority } = await params;
  let key: PublicKey;
  try {
    key = new PublicKey(authority);
    if (key.toBase58() !== authority) throw new Error("not canonical");
  } catch {
    return Response.json({ error: "Not an Account." }, { status: 400 });
  }
  if (!takeClient(clientKey(request.headers))) {
    return Response.json({ error: "Too many reads." }, { status: 429, headers: { "retry-after": "60" } });
  }
  try {
    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    return Response.json(await getAccountState(key, { fresh }), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof GpaUpstreamError) {
      const limited = e.status === 429;
      return Response.json({ error: e.message }, { status: limited ? 503 : 502, headers: limited ? { "retry-after": String(retryAfterSecs()) } : {} });
    }
    console.error("account", e);
    return Response.json({ error: "Account read failed." }, { status: 500 });
  }
}
