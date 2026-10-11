import type { WaitlistState } from "../../../../../src/app/(marketing)/waitlist-action";

export type { WaitlistState };

/** What the next join returns: a spot, `null` for a join with no spot (storage gave none), or "error". */
let next: number | null | "error" = 7;
export function setNextJoin(result: number | null | "error") {
  next = result;
}

/** Stands in for the server action: no Supabase, a short wait, then the scripted result. */
export async function joinWaitlist(_prev: WaitlistState, form: FormData): Promise<WaitlistState> {
  await new Promise((r) => setTimeout(r, 500));
  const email = String(form.get("email") ?? "");
  if (next === "error" || !email.includes("@"))
    return { status: "error", message: "We couldn't save that just now. Try again in a moment." };
  return next === null ? { status: "ok" } : { status: "ok", spot: next };
}
