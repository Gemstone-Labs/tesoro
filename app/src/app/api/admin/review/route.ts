import { DemoHttpError } from "@/server/request-auth";
import { handleReview, parseAdmins } from "@/server/admin/review";
import { loadSeasons } from "@/server/admin/load";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Flagged Accounts for the founders. POST, signed by a wallet in ADMIN_WALLETS. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const reply = await handleReview({ admins: parseAdmins(process.env.ADMIN_WALLETS), load: loadSeasons }, body, request.headers.get("authorization"));
    return Response.json(reply, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("admin review", e);
    return Response.json({ error: "That didn’t go through. Try again in a moment.", code: "error" }, { status: 500 });
  }
}
