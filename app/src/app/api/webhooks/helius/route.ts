import { after } from "next/server";
import { supabaseRpc } from "@/server/history/db";
import { openMatchPasses } from "@/server/open-match/env";
import { Connection } from "@solana/web3.js";
import { baseRpc } from "@/lib/chain/rpc-config";
import { endCaptureHooks } from "@/server/history/end-capture";
import { decodePending, receiveWebhook, rpcWebhookStore, WebhookHttpError } from "@/server/history/webhook";

export const runtime = "nodejs";

/**
 * The Helius raw webhook on tesoro_core (devnet). Helius sends the secret as the Authorization header it was created with
 * (HELIUS_WEBHOOK_SECRET). The transactions are stored and the answer goes out; the history rows and the open-Match table are written after it.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const store = rpcWebhookStore(supabaseRpc);
    const ends = endCaptureHooks(supabaseRpc, new Connection(baseRpc(process.env.TESORO_BASE_RPC), "confirmed"), (m) => console.warn("helius-webhook", m));
    const result = await receiveWebhook(
      {
        store,
        secret: process.env.HELIUS_WEBHOOK_SECRET,
        deliveredFinalized: process.env.HELIUS_WEBHOOK_FINALIZED === "1",
        capture: ends.capture,
        schedule: (work) => after(() => work().catch((e) => console.error("helius-webhook decode", e))),
        afterStore: async () => {
          const decoded = await decodePending({ store, rpc: supabaseRpc, captureEnds: ends.captureEnds, warn: (m) => console.warn("helius-webhook", m) }).catch((e) => console.error("helius-webhook decode", e));
          // Keeps the open-Match table in step; the cron picks up what this misses (rows not finalized yet).
          await openMatchPasses().pending().catch((e) => console.error("helius-webhook open-match", e));
          return decoded;
        },
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
