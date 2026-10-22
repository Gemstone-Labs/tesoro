import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { previewEntry } from "./entry";
import { storesFromSnapshot } from "./entry-snapshot";
import { fixtureHolding } from "./fixture";

const account = new Keypair().publicKey;
const snap = (holdings: ReturnType<typeof fixtureHolding>[], extra: { reservedTotal?: bigint; ticketNeed?: bigint } = {}) => ({ accountKey: account, stores: null, reservedTotal: 0n, ticketNeed: 0n, ...extra, holdings });

describe("entry preview from the snapshot", () => {
  const day = 86_400;
  const now = Math.floor(Date.now() / 1000);
  const fast = fixtureHolding(1, { amount: 300n, dueAt: now + 2 * day });
  const slow = fixtureHolding(2, { amount: 900n, dueAt: now + 200 * day });
  const won = fixtureHolding(3, { amount: 400n, isOwn: false, dueAt: now + 5 * day });

  it("draws the same lines the program would: own Gemas first, fastest first", () => {
    const p = previewEntry(storesFromSnapshot(snap([slow, won, fast])), 500n);
    expect(p.steps.map((s) => [s.take, s.isOwn])).toEqual([[300n, true], [200n, true]]);
    expect(p.gemasDueBy(now + 30 * day)).toBe(300n);
    expect(p.needsTicket).toBe(false);
  });

  it("counts Offer reservations out of what an entry may draw", () => {
    expect(() => previewEntry(storesFromSnapshot(snap([fast], { reservedTotal: 100n })), 250n)).toThrow(/Not enough/);
    expect(previewEntry(storesFromSnapshot(snap([fast], { reservedTotal: 100n })), 200n).lineCount).toBe(1);
  });

  it("keeps spill lines in the merged order", () => {
    const spilled = { ...fixtureHolding(4, { amount: 50n, dueAt: now + 1 * day }), store: "spill" as const };
    const p = previewEntry(storesFromSnapshot(snap([fast, spilled])), 100n);
    expect(p.steps[0].take).toBe(50n);
    expect(p.lineCount).toBe(2);
  });
});
