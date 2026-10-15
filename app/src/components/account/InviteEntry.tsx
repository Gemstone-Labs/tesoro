"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AlertIcon, Button } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { claimInvite } from "@/lib/chain/invite-client";
import { CLUSTER } from "@/lib/cluster-settings";
import { inviteFromSearch } from "@/lib/invite-link";
import { plainError } from "@/lib/errors";
import { TEST_ORIGIN } from "@/lib/site";
import "./account.css";

export interface InviteEntryViewProps {
  code: string;
  onCode: (v: string) => void;
  onSubmit: () => void;
  busy?: string | null;
  error?: string | null;
}

/** Mainnet is invite-only for now: the screen a wallet without an Account sees instead of the first-Account step. */
export function InviteEntryView({ code, onCode, onSubmit, busy = null, error = null }: InviteEntryViewProps) {
  return (
    <form
      className="stack ns"
      aria-label="Invite code"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h1 className="h2">Mainnet is invite-only for now</h1>
      <div className="field">
        <label className="label" htmlFor="invite-code">Enter your Invite code</label>
        <span className="cut cut-chip ctl">
          <input
            id="invite-code"
            className="input"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            value={code}
            onChange={(e) => onCode(e.target.value)}
            disabled={busy !== null}
          />
        </span>
        <small className="meta">Waitlist members get their code by email. It works once, for the wallet you are signed in with.</small>
      </div>
      {error && (
        <div className="status err" role="alert">
          <AlertIcon /> {error}
        </div>
      )}
      <Button type="submit" disabled={code.trim() === "" || busy !== null}>
        {busy ?? "Use my Invite"}
      </Button>
      <p className="meta">
        No code yet? <a href={TEST_ORIGIN}>Try test mode at test.playtesoro.com</a>, open to everyone.
      </p>
    </form>
  );
}

const OPEN_PREFIXES = ["/leaderboard", "/help", "/account"];

/** Wraps the app: while the Invite gate is on and the signed-in wallet has no Account, shows the Invite screen instead of the page. */
export function InviteGate({ children }: { children: ReactNode }) {
  const { auth, snapshot, onChain, loading, refresh } = useAccount();
  const path = usePathname();
  const [code, setCode] = useState(() => (typeof window === "undefined" ? "" : inviteFromSearch(window.location.search)));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signer = auth.signer;
  const blocked = CLUSTER.inviteRequired && onChain && !loading && snapshot !== null && !snapshot.exists && signer !== null && !OPEN_PREFIXES.some((p) => path?.startsWith(p));
  if (!blocked) return <>{children}</>;

  async function submit() {
    if (!signer) return;
    setError(null);
    setBusy("Creating your Account…");
    try {
      await claimInvite(signer, auth.getAccessToken, code.trim());
      await refresh();
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(null);
    }
  }

  return <InviteEntryView code={code} onCode={setCode} onSubmit={submit} busy={busy} error={error} />;
}
