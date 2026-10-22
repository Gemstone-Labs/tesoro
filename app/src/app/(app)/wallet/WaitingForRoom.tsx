"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { friendlyError } from "@/lib/chain/native-flow";
import { claimWaiting } from "@/lib/chain/overflow-flow";
import { waitingGemas, type WaitingRecord } from "@/lib/chain/overflow";
import { fmtGemas } from "@/lib/format";

/**
 * Gemas that found no room in the Account (a win or a refund that arrived while its storage was full): "N Gemas waiting for
 * room" and a Claim button that moves them in. The Gemas are the Player's own; Claim only needs room, which a Claim that
 * finds none leaves for the next try (the Redeem of a small leftover or any spend makes some).
 */
export function WaitingForRoomView({ records, busy, note, error, onClaim }: { records: readonly WaitingRecord[]; busy?: boolean; note?: string | null; error?: string | null; onClaim?: () => void }) {
  if (records.length === 0) return null;
  const gemas = Number(waitingGemas(records));
  return (
    <div className="wl-waiting" role="status">
      <p className="note">
        <b>{fmtGemas(gemas)} Gemas waiting for room.</b> They are yours; your Account was full when they arrived. Claim moves them in as soon as there is room.
      </p>
      <Button size="sm" disabled={busy || !onClaim} onClick={onClaim}>
        {busy ? "Claiming…" : "Claim"}
      </Button>
      {note && !error && <span className="meta">{note}</span>}
      {error && <span className="status err" role="alert">{error}</span>}
    </div>
  );
}

export function WaitingForRoom({ records }: { records: readonly WaitingRecord[] }) {
  const { auth, refresh } = useAccount();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const claim = async () => {
    if (!auth.signer) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await claimWaiting(auth.signer, auth.getAccessToken, records);
      await refresh();
      setNote("Claimed what fits. Anything left waits for more room.");
    } catch (e) {
      setError(friendlyError(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  return <WaitingForRoomView records={records} busy={busy} note={note} error={error} onClaim={auth.signer ? () => void claim() : undefined} />;
}
