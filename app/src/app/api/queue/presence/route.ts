import { DemoHttpError } from "@/server/request-auth";
import { handleFresh, handleTouch } from "@/server/presence/routes";
import { presenceStore } from "@/server/presence/supabase-store";
import { BASE_RPC } from "@/server/demo-advance";
import { Connection } from "@solana/web3.js";

export const runtime = "nodejs";

let conn: Connection | null = null;
/** A Match account as the base layer holds it, for checking a Seat key's ping. */
const readMatch = async (address: Parameters<NonNullable<Parameters<typeof handleTouch>[0]["readMatch"]>>[0]) => {
  conn ??= new Connection(BASE_RPC, "confirmed");
  const a = await conn.getAccountInfo(address, "confirmed");
  return a ? { owner: a.owner, data: a.data } : null;
};

function fail(e: unknown) {
  if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
  console.error("queue presence", e);
  return Response.json({ error: "That didn’t go through. Try again in a moment.", code: "error" }, { status: 500 });
}

/** The opener of a Queue Match touches its lease (signed by their wallet or the Match's Seat key). */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await handleTouch({ store: presenceStore, readMatch }, body, request.headers.get("authorization")));
  } catch (e) {
    return fail(e);
  }
}

/** `?ids=a,b,c`: the Matches whose lease is fresh. */
export async function GET(request: Request) {
  try {
    return Response.json(await handleFresh({ store: presenceStore }, new URL(request.url).searchParams.get("ids")), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return fail(e);
  }
}
