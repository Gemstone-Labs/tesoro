import { DemoHttpError } from "@/server/request-auth";
import { notifyDeps } from "@/server/notify/env";
import { handleAlert } from "@/server/notify/routes";

export const runtime = "nodejs";

/** The keeper reports an operations alert here, with the shared secret (NOTIFY_SECRET). Recipients are ALERT_EMAILS. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await handleAlert(notifyDeps(), process.env.NOTIFY_SECRET, request.headers.get("authorization"), body, process.env.ALERT_EMAILS));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("notify-alert", e);
    return Response.json({ error: "Alert failed.", code: "error" }, { status: 500 });
  }
}
