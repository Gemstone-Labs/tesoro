import { DemoHttpError } from "@/server/request-auth";
import { notifyDeps } from "@/server/notify/env";
import { handleSettings } from "@/server/notify/routes";
import { emailReady } from "@/server/notify/sender";

export const runtime = "nodejs";

/** A Player's email settings (status, set address, on/off), signed by their wallet. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await handleSettings(notifyDeps(), body, request.headers.get("authorization")));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("notify", e);
    return Response.json({ error: "That didn’t go through. Try again in a moment.", code: "error" }, { status: 500 });
  }
}

/** Whether this server sends email at all; the settings panel hides itself when it doesn't. */
export function GET() {
  return Response.json({ ready: emailReady() });
}
