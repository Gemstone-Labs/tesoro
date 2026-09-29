import { DemoHttpError, handleDemoRequest } from "@/server/demo-advance";

export const runtime = "nodejs";

/** Simulated · demo Advance. TEMPORARY: see app/docs/demo-funding.md. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    return Response.json(await handleDemoRequest(body, request.headers.get("authorization")));
  } catch (e) {
    if (e instanceof DemoHttpError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("demo-advance", e);
    return Response.json({ error: "Demo Advance failed.", code: "error" }, { status: 500 });
  }
}
