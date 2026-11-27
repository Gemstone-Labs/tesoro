/**
 * The target tag of an Entry Ticket (seat-keys ticket 14): the Match the wallet approved it for in `open_ticket`. With it the
 * seat key alone sends the `open_match` / `join_match` / `join_many_seat_match` that spends the complete Ticket there, within
 * `SEAT_ENTRY_SECS` of the Ticket's opening. Same derivation as `pots::open_target_tag` / `join_target_tag` on chain.
 */
import type { PublicKey } from "@solana/web3.js";
import type { TicketView } from "./ticket";

/** How long after `open_ticket` the seat key alone may spend the Ticket (`pots::SEAT_ENTRY_SECS`). */
export const SEAT_ENTRY_SECS = 15 * 60;
/** A Ticket's lifetime (`draw::TICKET_WINDOW_SECS`): its opening is `expiresAt - TICKET_WINDOW_SECS`. */
export const TICKET_WINDOW_SECS = 60 * 60;

const DOMAIN = new TextEncoder().encode("tesoro-ticket-target");

async function tagOf(parts: Uint8Array[]): Promise<bigint> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const h = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", all));
  return new DataView(h.buffer).getBigUint64(0, true);
}

/** The tag of a Ticket that opens the Match at `match` (`["match", account, n]`) with these terms. */
export const openTargetTag = (match: PublicKey, challenge: boolean, asset: number) => tagOf([DOMAIN, Uint8Array.of(0), match.toBytes(), Uint8Array.of(challenge ? 1 : 0, asset)]);

/** The tag of a Ticket that joins the Match (or boards the car) at `match`. */
export const joinTargetTag = (match: PublicKey) => tagOf([DOMAIN, Uint8Array.of(1), match.toBytes()]);

/** Whether the seat key alone may still spend a Ticket that expires at `expiresAt` (unix seconds), with `marginSecs` to land. */
export const inSeatWindow = (expiresAt: number, nowSecs: number, marginSecs = 60) => nowSecs + marginSecs < expiresAt - TICKET_WINDOW_SECS + SEAT_ENTRY_SECS;

/** Whether the seat key alone may send the entry that spends `t`: an Entry Ticket bound to this Match, still in its window (core checks the same). */
export const seatSpends = (t: Pick<TicketView, "kind" | "targetTag" | "expiresAt">, targetTag: bigint, nowSecs = Date.now() / 1000) =>
  t.kind === "entry" && t.targetTag !== 0n && t.targetTag === targetTag && inSeatWindow(t.expiresAt, nowSecs);
