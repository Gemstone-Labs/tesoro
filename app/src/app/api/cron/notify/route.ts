import { DemoHttpError } from "@/server/request-auth";
import { runNotifyCron } from "@/server/notify/cron";
import { webhookNotifyPasses } from "@/server/notify/env";

export const runtime = "nodejs";

/** Called every 5 minutes by the VPS timer tesoro-notify-cron (keeper/deploy), not by Vercel: emails for stored webhook transactions and the Delayed check. */
export async function GET(request: Request) {
  try {
    return Response.json(await runNotifyCron(webhookNotifyPasses(), process.env.CRON_SECRET, request.headers.get("authorization")));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("notify-cron", e);
    return Response.json({ error: "Notify cron failed.", code: "error" }, { status: 500 });
  }
}
