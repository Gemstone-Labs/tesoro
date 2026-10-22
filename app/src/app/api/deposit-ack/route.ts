import { DemoHttpError } from "@/server/request-auth";
import { handleDepositAck } from "@/server/deposit-ack/routes";
import { supabaseDepositAckStore } from "@/server/deposit-ack/supabase-store";

export const runtime = "nodejs";

/** A Player's deposit acknowledgment (status, confirm), signed by their wallet. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await handleDepositAck({ store: supabaseDepositAckStore }, body, request.headers.get("authorization")));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("deposit-ack", e);
    return Response.json({ error: "That didn’t go through. Try again in a moment.", code: "error" }, { status: 500 });
  }
}
