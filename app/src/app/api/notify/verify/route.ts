import { notifyDeps, siteUrl } from "@/server/notify/env";
import { verifyToken } from "@/server/notify/service";

export const runtime = "nodejs";

/** The link in the verify email. Lands on the Lobby with a note either way. */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  let ok = false;
  try {
    ok = await verifyToken(notifyDeps(), token);
  } catch (e) {
    console.error("notify-verify", e);
  }
  return Response.redirect(`${siteUrl()}/lobby?email=${ok ? "verified" : "invalid"}`, 303);
}
