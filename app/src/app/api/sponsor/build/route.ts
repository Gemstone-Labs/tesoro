import { DemoHttpError, NonceStore, verifySignedRequest } from "@/server/request-auth";
import { parseIntentText } from "@/server/sponsor/intent";
import { sponsor } from "@/server/sponsor/env";

export const runtime = "nodejs";
const nonces = new NonceStore();

/** Accepts the instructions a Player wants paid for, and returns the transaction message we built for them to sign. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const req = await verifySignedRequest("tesoro-sponsor", ["build"] as const, body, request.headers.get("authorization"), { nonces });
    return Response.json(await sponsor().build(req.address, parseIntentText(req.fields.intent), req.sub));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("sponsor build", e);
    return Response.json({ error: "Free transactions are unavailable.", code: "error" }, { status: 500 });
  }
}
