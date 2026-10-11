// Storybook: Privy without its provider. Stories only reach Privy through the Sign in sheet's email
// login, so that is all this fakes; the real package is never loaded (privacy blockers stop it).
import { useState } from "react";

type Status = "initial" | "sending-code" | "awaiting-code-input" | "submitting-code" | "done";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Any address gets a code; any 6-digit code signs in except 000000, which shows the error. */
export function useLoginWithEmail() {
  const [status, setStatus] = useState<Status>("initial");
  return {
    state: { status },
    async sendCode({ email }: { email: string }) {
      setStatus("sending-code");
      await wait(700);
      if (!email.includes("@")) {
        setStatus("initial");
        throw new Error("invalid email");
      }
      setStatus("awaiting-code-input");
    },
    async loginWithCode({ code }: { code: string }) {
      setStatus("submitting-code");
      await wait(700);
      if (code === "000000") {
        setStatus("awaiting-code-input");
        throw new Error("invalid code");
      }
      setStatus("done");
    },
  };
}
