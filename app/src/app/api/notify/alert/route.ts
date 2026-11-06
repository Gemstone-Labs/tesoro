import { DemoHttpError } from "@/server/request-auth";
import { handleAlert } from "@/server/notify/alert";
import { senderFromEnv } from "@/server/notify/sender";

export const runtime = "nodejs";

/** The keeper reports an operations alert here, with the shared secret (NOTIFY_SECRET). Recipients are ALERT_EMAILS. Founders only: Players are never mailed. */
export async function POST(request: Request) {
  try {
    const sender = senderFromEnv();
    if (!sender) throw new DemoHttpError(503, "not-configured", "Email is not set up on this server.");
    const body = await request.json().catch(() => null);
    return Response.json(await handleAlert(sender, process.env.NOTIFY_SECRET, request.headers.get("authorization"), body, process.env.ALERT_EMAILS));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("notify-alert", e);
    return Response.json({ error: "Alert failed.", code: "error" }, { status: 500 });
  }
}
