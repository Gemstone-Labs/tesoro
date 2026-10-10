import { NameCache, mainnetSources, parseRequest, resolveNames } from "@/server/names";
import { WindowLimiter } from "@/server/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 15;

const cache = new NameCache();
const perClient = new WindowLimiter(120, 60_000);

/** Primary .sol / .eth names for the wallets of the Players on screen. Public, read-only. */
export async function POST(request: Request) {
  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!perClient.take(client)) return Response.json({ error: "Too many requests." }, { status: 429 });
  const req = parseRequest(await request.json().catch(() => null));
  if (!req) return Response.json({ error: "Malformed request." }, { status: 400 });
  try {
    return Response.json(await resolveNames(req, mainnetSources(), cache));
  } catch (e) {
    console.error("names", e);
    return Response.json({ solana: {}, evm: {} });
  }
}
