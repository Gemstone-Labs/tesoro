"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { DrawError, previewEntry, readEntryStores, type EntryPreview } from "./entry";
import { findOpenTickets, stagedEntryState, type StagedEntry, type TicketView } from "./ticket";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";

/** The entry as the program will draw it: lines, fast vs slow Gemas, whether it needs a Ticket. Reads the funder's basket and spill once per entry size. */
export interface EntryPreviewState {
  preview: EntryPreview | null;
  /** Why the entry cannot be made, or null. */
  problem: "zero" | "insufficient" | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * `authority`: the wallet; `backerAccount`: the Backer's Account when a Backing funds the entry (their Gemas are drawn),
 * else the Player's own Gemas.
 */
export function useEntryPreview(authority: PublicKey | null, entry: number | null, backerAccount?: PublicKey | null): EntryPreviewState {
  const [read, setRead] = useState<{ key: string; preview: EntryPreview | null; problem: "zero" | "insufficient" | null } | null>(null);
  const [tick, setTick] = useState(0);
  const funder = backerAccount ?? (authority ? BlockPuzzleChain.coreAccount(authority) : null);
  const key = funder && entry ? `${funder.toBase58()}:${entry}:${backerAccount ? "b" : "o"}:${tick}` : null;
  useEffect(() => {
    if (!funder || !entry || !key) return;
    let stopped = false;
    readEntryStores(funder).then(
      (stores) => {
        if (stopped) return;
        try {
          setRead({ key, preview: previewEntry(stores, BigInt(entry), { backing: !!backerAccount }), problem: null });
        } catch (e) {
          if (!(e instanceof DrawError)) throw e;
          setRead({ key, preview: null, problem: e.code });
        }
      },
      () => !stopped && setRead({ key, preview: null, problem: null }),
    );
    return () => {
      stopped = true;
    };
    // `key` stands for funder, entry and backing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const current = read && read.key === key ? read : null;
  return { preview: current?.preview ?? null, problem: current?.problem ?? null, loading: key !== null && current === null, refresh };
}

export interface OpenTicketsState {
  /** Tickets of this Account still being prepared or cancelled, newest first. */
  tickets: { ticket: TicketView; state: StagedEntry }[];
  loading: boolean;
  refresh: () => void;
}

/** Entries left half-prepared (a reload, a closed tab): resume them with `resumeTicket` or cancel them with `cancelTicket`. */
export function useOpenTickets(account: PublicKey | null): OpenTicketsState {
  const [read, setRead] = useState<{ key: string; tickets: OpenTicketsState["tickets"] } | null>(null);
  const [tick, setTick] = useState(0);
  const key = account ? `${account.toBase58()}:${tick}` : null;
  useEffect(() => {
    if (!account || !key) return;
    let stopped = false;
    findOpenTickets(account).then(
      (rows) => !stopped && setRead({ key, tickets: rows.map((ticket) => ({ ticket, state: stagedEntryState(ticket) })) }),
      () => !stopped && setRead({ key, tickets: [] }),
    );
    return () => {
      stopped = true;
    };
    // `key` stands for account and refresh count
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const current = read && read.key === key ? read : null;
  return { tickets: current?.tickets ?? [], loading: key !== null && current === null, refresh };
}

/** Plain words for the preview line under an entry button. `fastBy`: unix seconds; Gemas due by then are "fast". */
export function describeEntry(p: EntryPreview, fastBy: number): { headline: string; detail: string | null } {
  const fast = p.gemasDueBy(fastBy);
  const headline = p.needsTicket
    ? `Your entry uses ${p.lineCount} batches of Gemas, so it is prepared in ${p.stageTxs} step${p.stageTxs === 1 ? "" : "s"} first.`
    : `Your entry uses ${p.lineCount} batch${p.lineCount === 1 ? "" : "es"} of Gemas, fastest first.`;
  const detail = p.entry > 0n && fast > 0n ? `${fast} of ${p.entry} Gemas are from Locks that repay soon.` : null;
  return { headline, detail };
}
