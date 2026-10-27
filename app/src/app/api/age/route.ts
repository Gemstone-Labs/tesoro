import { DemoHttpError } from "@/server/request-auth";
import { handleAge } from "@/server/age/routes";
import { ageStore } from "@/server/age/env";

export const runtime = "nodejs";

/** A Player's 18+ confirmation (status, confirm), signed by their wallet. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await handleAge({ store: ageStore() }, body, request.headers.get("authorization")));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("age", e);
    return Response.json({ error: "That didn’t go through. Try again in a moment.", code: "error" }, { status: 500 });
  }
}
