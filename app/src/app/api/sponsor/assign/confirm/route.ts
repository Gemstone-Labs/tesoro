import { sponsor } from "@/server/sponsor/env";

export const runtime = "nodejs";

/** The page sent the join `/api/sponsor/assign` built: claims the table in the pool once its Assignment is on base. The meta carries our MAC. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { meta?: unknown; mac?: unknown } | null;
  if (typeof body?.meta !== "string" || typeof body.mac !== "string") return Response.json({ confirmed: false }, { status: 400 });
  try {
    return Response.json({ confirmed: await sponsor().confirmSelfPaid(body.meta, body.mac) });
  } catch (e) {
    console.error("sponsor assign confirm", e);
    return Response.json({ confirmed: false }, { status: 500 });
  }
}
