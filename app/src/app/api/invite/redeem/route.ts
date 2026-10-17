import { DemoHttpError } from "@/server/request-auth";
import { redeemDeps } from "@/server/invite/env";
import { handleRedeem } from "@/server/invite/redeem";

export const runtime = "nodejs";

/** Redeems an Invite code: returns a create-Account transaction co-signed by the Invite key, for the Player to sign and send. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await handleRedeem(redeemDeps(), body, request.headers.get("authorization")));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("invite", e);
    return Response.json({ error: "That didn’t go through. Try again in a moment.", code: "error" }, { status: 500 });
  }
}
