import { DemoHttpError } from "@/server/request-auth";
import { sponsor } from "@/server/sponsor/env";

export const runtime = "nodejs";

/** Whether free transactions are on, and the relayer address a sponsored instruction names as its payer. */
export async function GET() {
  try {
    return Response.json(await sponsor().status());
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("sponsor", e);
    return Response.json({ error: "Free transactions are unavailable.", code: "error" }, { status: 500 });
  }
}
