import { DemoHttpError } from "@/server/request-auth";
import { notifyDeps } from "@/server/notify/env";
import { handleDigest } from "@/server/notify/routes";

export const runtime = "nodejs";

/** The keeper calls this once a day, with the shared secret (NOTIFY_SECRET): sends and clears the held digests. */
export async function POST(request: Request) {
  try {
    return Response.json(await handleDigest(notifyDeps(), process.env.NOTIFY_SECRET, request.headers.get("authorization")));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("notify-digest", e);
    return Response.json({ error: "Digest failed.", code: "error" }, { status: 500 });
  }
}
