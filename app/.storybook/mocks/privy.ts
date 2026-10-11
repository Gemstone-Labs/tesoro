// Storybook: Privy without its provider. Only the email login is faked, so the Sign in sheet can walk
// through the code step offline; everything else is the real package.
import { useState } from "react";

export * from "@privy-io/react-auth";

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
