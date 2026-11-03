import { after } from "next/server";
import { supabaseRpc } from "@/server/history/db";
import { decodePending, receiveWebhook, rpcWebhookStore, WebhookHttpError } from "@/server/history/webhook";

export const runtime = "nodejs";

/**
 * The Helius raw webhook on tesoro_core (devnet). Helius sends the secret as the Authorization header it was created with
 * (HELIUS_WEBHOOK_SECRET). The transactions are stored and the answer goes out; the history rows are written after it.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const store = rpcWebhookStore(supabaseRpc);
    const result = await receiveWebhook(
      {
        store,
        secret: process.env.HELIUS_WEBHOOK_SECRET,
        deliveredFinalized: process.env.HELIUS_WEBHOOK_FINALIZED === "1",
        schedule: (work) => after(() => work().catch((e) => console.error("helius-webhook decode", e))),
        afterStore: () => decodePending({ store, rpc: supabaseRpc, warn: (m) => console.warn("helius-webhook", m) }),
      },
      request.headers.get("authorization"),
      body,
    );
    return Response.json(result);
  } catch (e) {
    if (e instanceof WebhookHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("helius-webhook", e);
    return Response.json({ error: "Webhook failed.", code: "error" }, { status: 500 });
  }
}
