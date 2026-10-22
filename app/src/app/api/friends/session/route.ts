import { DemoHttpError } from "@/server/request-auth";
import { friendsDeps } from "@/server/friends/env";
import { requestIsHttps, sessionCookie, sessionCookieName, startSession } from "@/server/friends/routes";

export const runtime = "nodejs";

/** Starts a 30-day Friends session from one wallet signature (scope tesoro-friends, step session). */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const s = await startSession(friendsDeps(), body, request.headers.get("authorization"));
    const https = requestIsHttps(request);
    return Response.json({ account: s.account }, { headers: { "set-cookie": sessionCookie(sessionCookieName(https), s.token, s.maxAgeSecs, https) } });
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("friends-session", e);
    return Response.json({ error: "That didn’t go through. Try again in a moment.", code: "error" }, { status: 500 });
  }
}
