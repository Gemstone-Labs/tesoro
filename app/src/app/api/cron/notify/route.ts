import { DemoHttpError } from "@/server/request-auth";
import { runOpenMatchCron } from "@/server/open-match/cron";
import { openMatchPasses } from "@/server/open-match/env";

export const runtime = "nodejs";

/**
 * Called every 5 minutes by the VPS timer tesoro-notify-cron (keeper/deploy), not by Vercel. It keeps the open-Match table
 * (the keeper's safety sweep reads it) up to date from stored webhook transactions. The route and timer keep their old
 * "notify" names; nothing is mailed.
 */
export async function GET(request: Request) {
  try {
    return Response.json(await runOpenMatchCron(openMatchPasses(), process.env.CRON_SECRET, request.headers.get("authorization")));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("open-match-cron", e);
    return Response.json({ error: "Cron failed.", code: "error" }, { status: 500 });
  }
}
