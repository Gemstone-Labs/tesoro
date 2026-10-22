import { supabaseRpc } from "@/server/history/db";
import { parseAdmins } from "@/server/admin/review";
import { handleListingAdmin } from "@/server/listing/service";
import { DemoHttpError } from "@/server/request-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Studio applications for the founders: list, accept or reject, record a payment, feature. POST, signed by a wallet in ADMIN_WALLETS. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const reply = await handleListingAdmin({ admins: parseAdmins(process.env.ADMIN_WALLETS), rpc: supabaseRpc }, body, request.headers.get("authorization"));
    return Response.json(reply, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("admin listing", e);
    return Response.json({ error: "That didn’t go through. Try again in a moment." }, { status: 500 });
  }
}
