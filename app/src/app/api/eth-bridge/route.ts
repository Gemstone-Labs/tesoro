import { DemoHttpError } from "@/server/demo-advance";
import { handleEthPrice, handleEthRequest } from "@/server/eth-bridge";

export const runtime = "nodejs";
export const maxDuration = 60;

/** The devnet price an Advance on an ETH or HYPE Position is issued at (public): `?asset=HYPE`, ETH by default. */
export async function GET(request: Request) {
  return Response.json(await handleEthPrice(new URL(request.url).searchParams.get("asset")));
}

/** Hoodi ETH top-up, the permissionless bridge steps and the oracle-priced Advance. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await handleEthRequest(body, request.headers.get("authorization")));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("eth-bridge", e);
    return Response.json({ error: "Lock step failed.", code: "error" }, { status: 500 });
  }
}
