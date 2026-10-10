"use client";

import { useState } from "react";
import { useLoginWithEmail } from "@privy-io/react-auth";
import { AlertIcon, Button, Label, Sheet } from "@/components/ui";

export function SignInSheet({
  open,
  reason,
  onClose,
  onSignedIn,
  onWallet,
}: {
  open: boolean;
  reason?: string;
  onClose: () => void;
  onSignedIn: () => void;
  /** Hands over to the wallet picker for one chain family. */
  onWallet: (family: "solana" | "evm") => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Sign in">
      <SignInForm reason={reason} onSignedIn={onSignedIn} onWallet={onWallet} />
    </Sheet>
  );
}

function SignInForm({ reason, onSignedIn, onWallet }: { reason?: string; onSignedIn: () => void; onWallet: (family: "solana" | "evm") => void }) {
  const { sendCode, loginWithCode, state } = useLoginWithEmail();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const codeStep = state.status === "awaiting-code-input" || state.status === "submitting-code" || (error !== null && code !== "");
  const busy = state.status === "sending-code" || state.status === "submitting-code";

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await sendCode({ email: email.trim() });
    } catch {
      setError("Could not send the code. Check the email address and try again.");
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await loginWithCode({ code: code.trim() });
      onSignedIn();
    } catch {
      setError("That code did not work. Check it, or go back and send a new one.");
    }
  }

  return (
    <>
      <p className="meta">
        {reason ? `Sign in to ${reason}. ` : ""}
        Use a wallet or an email: either way your Account gets a Solana address and an EVM address, created for you. Browsing needs no sign-in.
      </p>
      {!codeStep && (
        <div className="stack signin-wallets">
          <Label>Connect a wallet</Label>
          <button type="button" className="cut cut-card signin-wallet" onClick={() => onWallet("solana")}>
            <b>Solana wallet</b>
            <small>Phantom, Solflare, Backpack</small>
          </button>
          <button type="button" className="cut cut-card signin-wallet" onClick={() => onWallet("evm")}>
            <b>Ethereum wallet</b>
            <small>MetaMask, Rabby, WalletConnect</small>
          </button>
          <p className="signin-or"><span>or use email</span></p>
        </div>
      )}
      {!codeStep ? (
        <form className="stack" onSubmit={send}>
          <div className="field">
            <label className="label" htmlFor="signin-email">Email</label>
            <input
              id="signin-email"
              className="cut input"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button type="submit" block disabled={busy || email.trim() === ""}>
            {state.status === "sending-code" ? "Sending code…" : "Email me a code"}
          </Button>
        </form>
      ) : (
        <form className="stack" onSubmit={verify}>
          <div className="field">
            <label className="label" htmlFor="signin-code">6-digit code sent to {email}</label>
            <input
              id="signin-code"
              className="cut input mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <Button type="submit" block disabled={busy || code.length < 6}>
            {state.status === "submitting-code" ? "Checking…" : "Sign in"}
          </Button>
          <Button type="button" size="sm" onClick={() => { setCode(""); setError(null); void sendCode({ email: email.trim() }); }}>
            Send a new code
          </Button>
        </form>
      )}
      {error && (
        <div className="status err" role="alert">
          <AlertIcon /> {error}
        </div>
      )}
      <p className="note">Test mode: nothing here has real value.</p>
    </>
  );
}
