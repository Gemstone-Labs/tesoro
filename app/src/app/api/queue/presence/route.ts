import { DemoHttpError } from "@/server/request-auth";
import { handleFresh, handleTouch } from "@/server/presence/routes";
import { presenceStore } from "@/server/presence/supabase-store";

export const runtime = "nodejs";

function fail(e: unknown) {
  if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
  console.error("queue presence", e);
  return Response.json({ error: "That didn’t go through. Try again in a moment.", code: "error" }, { status: 500 });
}

/** The opener of a Queue Match touches its lease (signed by their wallet). */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await handleTouch({ store: presenceStore }, body, request.headers.get("authorization")));
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
