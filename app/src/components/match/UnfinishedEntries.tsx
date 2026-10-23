"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import { entryError } from "@/lib/chain/entry-errors";
import { cancelTicket, resumeTicket } from "@/lib/chain/ticket";
import { useOpenTickets } from "@/lib/chain/use-entry";
import { fmtGemas } from "@/lib/format";

/**
 * Entries left half-prepared (a closed tab, a lost connection): their Gemas are safe in the Ticket and come back whole on
 * Cancel. Finish continues the same Ticket. Shows nothing when there are none.
 */
export function UnfinishedEntries() {
  const { auth, refresh } = useAccount();
  const signer = auth.signer;
  const { tickets, refresh: reload } = useOpenTickets(signer ? BlockPuzzleChain.coreAccount(signer.publicKey) : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = tickets.filter((t) => t.ticket.state === "open" && t.ticket.kind === "entry");
  if (!signer || open.length === 0) return null;
  const act = async (id: string, run: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await run();
      reload();
      await refresh();
    } catch (e) {
      setError(entryError(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="cut cut-card enter-unfinished" aria-label="Unfinished entries">
      {open.map(({ ticket, state }) => {
        const id = ticket.address.toBase58();
        return (
          <div key={id} className="stack">
            <p>
              <b>An entry is half prepared.</b> {fmtGemas(Number(state.staged))} of {fmtGemas(Number(state.target))} Gemas are set aside for it. They go back to your Account if you cancel.
            </p>
            <div className="hstack wrap">
              <Button variant="money" size="sm" disabled={busy !== null} onClick={() => void act(id, () => resumeTicket(signer, auth.getAccessToken, ticket))}>
                {busy === id ? "Working…" : "Finish"}
              </Button>
              <Button size="sm" disabled={busy !== null} onClick={() => void act(id, () => cancelTicket(signer, auth.getAccessToken, ticket))}>
                Cancel entry
              </Button>
            </div>
          </div>
        );
      })}
      {error && <p className="status err" role="alert">{error}</p>}
    </div>
  );
}
