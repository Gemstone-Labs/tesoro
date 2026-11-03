import { DemoHttpError } from "@/server/request-auth";
import { runDigestCron } from "@/server/notify/cron";
import { sendDigests } from "@/server/notify/digest";
import { notifyDeps } from "@/server/notify/env";

export const runtime = "nodejs";

/** The Vercel cron (app/vercel.json): the daily digest, 08:00 UTC. */
export async function GET(request: Request) {
  try {
    return Response.json(await runDigestCron(() => sendDigests(notifyDeps()), process.env.CRON_SECRET, request.headers.get("authorization")));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("digest-cron", e);
    return Response.json({ error: "Digest cron failed.", code: "error" }, { status: 500 });
  }
}
