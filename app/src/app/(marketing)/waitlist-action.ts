"use server";

import { headers } from "next/headers";
import { parseEmail } from "@/lib/email";
import { WindowLimiter } from "@/server/rate-limit";
import { passesChallenge } from "@/server/turnstile";
import { join } from "@/server/waitlist";

export type WaitlistState = { status: "idle" | "ok" | "error"; message?: string; spot?: number };

const perClient = new WindowLimiter(5, 60_000);

const clean = (raw: unknown, max: number) => (typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : null);

export async function joinWaitlist(_prev: WaitlistState, form: FormData): Promise<WaitlistState> {
  if (clean(form.get("company"), 1)) return { status: "ok" };
  const email = parseEmail(form.get("email"));
  if (!email) return { status: "error", message: "That email doesn't look right. Check it and try again." };
  const h = await headers();
  const client = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!perClient.take(client)) return { status: "error", message: "Too many tries. Wait a minute and try again." };
  if (!(await passesChallenge(form.get("cf-turnstile-response"), client === "local" ? null : client))) {
    perClient.refund(client);
    return { status: "error", message: "We couldn't check that you're human. Reload the page and try again." };
  }
  try {
    const spot = await join(email, { source: clean(form.get("utm_source"), 80), referrer: clean(form.get("referrer"), 300) });
    return spot ? { status: "ok", spot } : { status: "ok" };
  } catch (e) {
    console.error("waitlist", e);
    perClient.refund(client);
    return { status: "error", message: "We couldn't save that just now. Try again in a moment." };
  }
}
