import { DemoHttpError } from "@/server/request-auth";
import { notifyDeps } from "@/server/notify/env";
import { handleEvents } from "@/server/notify/routes";

export const runtime = "nodejs";

/** The keeper reports Match, Backing, Position and Season facts here, with the shared secret (NOTIFY_SECRET). */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await handleEvents(notifyDeps(), process.env.NOTIFY_SECRET, request.headers.get("authorization"), body));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("notify-events", e);
    return Response.json({ error: "Events failed.", code: "error" }, { status: 500 });
  }
}
