import { supabaseRpc } from "@/server/history/db";
import { applyForListing } from "@/server/listing/service";
import { DemoHttpError } from "@/server/request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The free Studio listing application. Public; every field is checked in lib/listing/apply.ts and again by the database. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await applyForListing(supabaseRpc, body), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("listing apply", e);
    return Response.json({ error: "That didn’t go through. Try again in a moment." }, { status: 500 });
  }
}
