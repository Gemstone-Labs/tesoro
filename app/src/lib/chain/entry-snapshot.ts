import { PublicKey } from "@solana/web3.js";
import { FLAG_BACKING_OPEN, FLAG_TICKET_OPEN, type Line, type Store, type StoreHeader } from "./basket";
import type { AccountSnapshot, ChainHolding } from "./read";

/**
 * The basket and spill as the entry draw sees them, rebuilt from an Account snapshot that is already in the app
 * (so the preview needs no read of its own). A line carries only what the draw orders by and takes: key fields and amount.
 */
export function storesFromSnapshot(s: Pick<AccountSnapshot, "holdings" | "reservedTotal" | "ticketNeed" | "stores" | "accountKey">): { basket: Store; spill: Store } {
  const line = (h: ChainHolding): Line => ({
    side: h.line.side,
    classId: h.classId,
    tranche: h.tranche,
    dueAt: h.line.dueAt,
    source: h.source,
    amount: h.amount,
    uncovered: 0n,
    p: 0n,
    scale: 0,
    epoch: 0,
    ck: 0,
    shares: 0n,
  });
  const store = (which: "basket" | "spill"): Store => {
    const lines = s.holdings.filter((h) => h.store === which).map(line);
    const playable = (side: number) => lines.filter((l) => l.classId >= 3 && l.side === side).reduce((a, l) => a + l.amount, 0n);
    const sum = s.stores?.[which];
    const header: StoreHeader = {
      version: 3,
      bump: 0,
      flags: (sum?.flags ?? 0) & (FLAG_TICKET_OPEN | FLAG_BACKING_OPEN),
      len: lines.length,
      first: 0,
      account: s.accountKey ?? PublicKey.default,
      ownTotal: playable(0),
      wonTotal: playable(1),
      feeTotal: lines.filter((l) => l.classId < 3).reduce((a, l) => a + l.amount, 0n),
      reservedTotal: which === "basket" ? s.reservedTotal : 0n,
      sponsoredLamports: sum?.sponsoredLamports ?? 0n,
      ticketNeed: which === "basket" ? s.ticketNeed : 0n,
      roomReserved: sum?.roomReserved ?? 0,
      capacity: Math.max(sum?.capacity ?? 0, lines.length),
    };
    return { header, lines };
  };
  return { basket: store("basket"), spill: store("spill") };
}
