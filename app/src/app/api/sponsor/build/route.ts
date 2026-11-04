import { DemoHttpError, NonceStore } from "@/server/request-auth";
import { handleBuild } from "@/server/sponsor/routes";
import { sponsor } from "@/server/sponsor/env";

export const runtime = "nodejs";
const nonces = new NonceStore();

/** Accepts the instructions a Player wants paid for, and returns the transaction message we built for them to sign. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await handleBuild(sponsor(), nonces, body, request.headers.get("authorization"), request.headers.get("privy-id-token")));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("sponsor build", e);
    return Response.json({ error: "Free transactions are unavailable.", code: "error" }, { status: 500 });
  }
}
