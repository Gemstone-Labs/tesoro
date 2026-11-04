import { DemoHttpError, NonceStore } from "@/server/request-auth";
import { handleAssign } from "@/server/sponsor/routes";
import { sponsor } from "@/server/sponsor/env";

export const runtime = "nodejs";
const nonces = new NonceStore();

/** A join the Player pays for: returns it with a table assignment added and the Table operator's signature on it. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await handleAssign(sponsor(), nonces, body, request.headers.get("authorization"), request.headers.get("privy-id-token")));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("sponsor assign", e);
    return Response.json({ error: "Table assignment is unavailable.", code: "error" }, { status: 500 });
  }
}
