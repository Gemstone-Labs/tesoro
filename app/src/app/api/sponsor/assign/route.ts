import { DemoHttpError, NonceStore, verifySignedRequest } from "@/server/request-auth";
import { parseIntentText } from "@/server/sponsor/intent";
import { sponsor } from "@/server/sponsor/env";

export const runtime = "nodejs";
const nonces = new NonceStore();

/** A join the Player pays for: returns it with a table assignment added and the Table operator's signature on it. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const req = await verifySignedRequest("tesoro-sponsor", ["assign"] as const, body, request.headers.get("authorization"), { nonces });
    return Response.json(await sponsor().buildSelfPaid(req.address, parseIntentText(req.fields.intent)));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("sponsor assign", e);
    return Response.json({ error: "Table assignment is unavailable.", code: "error" }, { status: 500 });
  }
}
