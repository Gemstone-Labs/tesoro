import { DemoHttpError } from "@/server/request-auth";
import { handleOrders, ordersDeps } from "@/server/admin/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Open Instant Redeem orders for the founders. POST, signed by a wallet in ADMIN_WALLETS. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const reply = await handleOrders(ordersDeps(), body, request.headers.get("authorization"));
    return Response.json(reply, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("admin orders", e);
    return Response.json({ error: "That didn’t go through. Try again in a moment.", code: "error" }, { status: 500 });
  }
}
