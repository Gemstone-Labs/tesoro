import { cookies } from "next/headers";
import { DemoHttpError } from "@/server/request-auth";
import { friendsDeps } from "@/server/friends/env";
import { handleFriends, requestIsHttps, sessionCookie, sessionCookieName } from "@/server/friends/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every Friends action (body.op) for the Account of the Friends session cookie. */
export async function POST(request: Request) {
  const https = requestIsHttps(request);
  const name = sessionCookieName(https);
  try {
    const body = await request.json().catch(() => null);
    const out = await handleFriends(friendsDeps(), body, {
      token: (await cookies()).get(name)?.value ?? null,
      authorization: request.headers.get("authorization"),
      origin: request.headers.get("origin"),
      host: request.headers.get("host"),
    });
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (out.signOut) headers["set-cookie"] = sessionCookie(name, "", 0, https);
    return Response.json(out.result, { headers });
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("friends", e);
    return Response.json({ error: "That didn’t go through. Try again in a moment.", code: "error" }, { status: 500 });
  }
}
