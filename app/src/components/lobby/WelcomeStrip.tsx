"use client";

import { Button } from "@/components/ui";
import { practiceHref } from "@/lib/game-params";
import { useAccount } from "@/lib/account";

/** Signed-out visitors only: what is free right now and how playing for Gemas starts. */
export function WelcomeStrip() {
  const { auth } = useAccount();
  if (auth.status !== "signed-out") return null;
  return (
    <div className="cut cut-card welcome-strip">
      <p>
        <b>New here?</b> Practice free, no account needed. To play for Gemas, lock crypto in a Position and take an Advance.
      </p>
      <Button href={practiceHref("block-puzzle")}>Practice free</Button>
    </div>
  );
}
