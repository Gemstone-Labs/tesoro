import { DemoHttpError } from "@/server/request-auth";
import { sponsor } from "@/server/sponsor/env";

export const runtime = "nodejs";

/** Signs as fee payer and sends a message we built, once the Player has signed it. The MAC proves we built it. */
export async function POST(request: Request) {
  try {
    const b = (await request.json().catch(() => null)) as { tx?: unknown; meta?: unknown; mac?: unknown } | null;
    if (!b || typeof b.tx !== "string" || typeof b.meta !== "string" || typeof b.mac !== "string") throw new DemoHttpError(400, "bad-request", "Malformed request.");
    return Response.json(await sponsor().submit(b.tx, b.meta, b.mac));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("sponsor submit", e);
    return Response.json({ error: "Free transactions are unavailable.", code: "error" }, { status: 500 });
  }
}
