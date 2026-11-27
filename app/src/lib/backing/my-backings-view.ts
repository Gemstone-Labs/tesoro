import type { AuthStatus } from "@/lib/auth/types";

export type MyBackingsView = "sign-in" | "loading" | "empty" | "list";

/** Which My Backings view to show: the sign-in invite is for visitors, the empty state only for an Account that has none. */
export function myBackingsView(s: { status: AuthStatus; accountKnown: boolean; boardLoaded: boolean; backings: number }): MyBackingsView {
  if (s.status === "signed-out") return "sign-in";
  if (s.status !== "signed-in" || !s.accountKnown || !s.boardLoaded) return "loading";
  return s.backings === 0 ? "empty" : "list";
}
