"use client";

import Link from "next/link";
import { useState } from "react";
import { useLoginWithEmail } from "@privy-io/react-auth";
import { TesoroMark } from "@/components/brand";
import { AlertIcon, Button, ChainGlyph, Sheet } from "@/components/ui";

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
    <Sheet
      open={open}
      onClose={onClose}
      title={reason ? `Sign in to ${reason}` : "Welcome to Tesoro"}
      lead={<TesoroMark size={52} />}
      className="signin"
    >
      <SignInForm onSignedIn={onSignedIn} onWallet={onWallet} />
    </Sheet>
  );
}

/** Email is the main path; wallets sit under it as a pair. */
function SignInForm({ onSignedIn, onWallet }: { onSignedIn: () => void; onWallet: (family: "solana" | "evm") => void }) {
  const { sendCode, loginWithCode, state } = useLoginWithEmail();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // "Change" goes back to the email form while Privy still waits for a code.
  const [editing, setEditing] = useState(false);
  const codeStep = !editing && (state.status === "awaiting-code-input" || state.status === "submitting-code" || (error !== null && code !== ""));
  const sending = state.status === "sending-code";
  const checking = state.status === "submitting-code";

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setEditing(false);
    try {
      await sendCode({ email: email.trim() });
    } catch {
      setError("Could not send the code. Check the email address and try again.");
    }
  }

  async function verify(value: string) {
    setError(null);
    try {
      await loginWithCode({ code: value });
      onSignedIn();
    } catch {
      setError("That code did not work. Check it, or send a new one.");
    }
  }

  function resend() {
    setCode("");
    setError(null);
    void sendCode({ email: email.trim() });
  }

  return (
    <>
      <p className="signin-lede">{codeStep ? "Check your inbox." : "Sign in or create your Account. It takes a minute."}</p>
      {codeStep ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void verify(code);
          }}
        >
          <p className="signin-sent">
            We sent a 6-digit code to <b>{email}</b>.{" "}
            <button type="button" className="signin-link" onClick={() => { setCode(""); setError(null); setEditing(true); }}>
              Change
            </button>
          </p>
          <CodeCells
            email={email}
            value={code}
            onChange={(v) => {
              setCode(v);
              if (v.length === 6) void verify(v);
            }}
          />
          <button type="submit" className="cut cut-btn btn block signin-go" disabled={checking || code.length < 6}>
            {checking ? "Checking…" : "Sign in"}
          </button>
          <p className="signin-resend">
            No email? Check spam, or{" "}
            <button type="button" className="signin-link" onClick={resend}>send a new code</button>.
          </p>
        </form>
      ) : (
        <>
          <form className="stack" onSubmit={send}>
            <span className="cut cut-chip ctl">
              <input
                className="input signin-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="Your email"
                aria-label="Email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </span>
            <button type="submit" className="cut cut-btn btn block signin-go" disabled={sending || email.trim() === ""}>
              {sending ? "Sending code…" : "Continue with email"}
            </button>
          </form>
          <p className="signin-or"><span>or use a wallet</span></p>
          <div className="signin-wallets">
            <Button onClick={() => onWallet("solana")}>
              <ChainGlyph asset={0} /> Solana
            </Button>
            {/* one address serves Ethereum and HyperEVM, so the Ethereum button carries both marks */}
            <Button onClick={() => onWallet("evm")}>
              <span className="signin-marks"><ChainGlyph asset={1} /><ChainGlyph asset={2} /></span> Ethereum
            </Button>
          </div>
        </>
      )}
      {error && (
        <div className="status err" role="alert">
          <AlertIcon /> {error}
        </div>
      )}
      <p className="signin-foot">
        By continuing you agree to the <Link href="/terms" target="_blank">Terms</Link> and <Link href="/privacy" target="_blank">Privacy Policy</Link>.
      </p>
      <p className="signin-foot">
        One Account works on Solana, Ethereum and HYPE.
        <br />
        Browsing needs no sign-in · Test mode
      </p>
    </>
  );
}

/** Six cells drawn over one real input, so paste and one-time-code autofill keep working. */
function CodeCells({ email, value, onChange }: { email: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="signin-cells">
      <input
        className="signin-cells-input"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        aria-label={`6-digit code sent to ${email}`}
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      />
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className={`cut cut-chip signin-cell${i === value.length ? " at" : ""}${value[i] ? " on" : ""}`} aria-hidden="true">
          {value[i] ?? ""}
        </span>
      ))}
    </label>
  );
}
