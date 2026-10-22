import { supabaseRpc } from "@/server/history/db";
import { applyForListing } from "@/server/listing/service";
import { WindowLimiter } from "@/server/rate-limit";
import { passesChallenge } from "@/server/turnstile";
import { DemoHttpError } from "@/server/request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const perClient = new WindowLimiter(5, 60_000);

/** The free Studio listing application. Public; every field is checked in lib/listing/apply.ts and again by the database. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    if (!perClient.take(client)) return Response.json({ error: "Too many tries. Wait a minute and try again." }, { status: 429 });
    const token = body && typeof body === "object" ? (body as Record<string, unknown>).turnstile : undefined;
    if (!(await passesChallenge(token, client === "local" ? null : client))) {
      perClient.refund(client);
      return Response.json({ error: "We couldn’t check that you’re human. Reload the page and try again." }, { status: 400 });
    }
    return Response.json(await applyForListing(supabaseRpc, body), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("listing apply", e);
    return Response.json({ error: "That didn’t go through. Try again in a moment." }, { status: 500 });
  }
}
