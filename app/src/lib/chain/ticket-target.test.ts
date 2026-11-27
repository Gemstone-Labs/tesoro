import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { inSeatWindow, joinTargetTag, openTargetTag, seatSpends } from "./ticket-target";

describe("Entry Ticket target tags", () => {
  // the same vectors as the Rust test `target_tags_match_the_app` (computed independently with Python's hashlib)
  const key = new PublicKey(new Uint8Array(32).fill(7));
  it("match core's derivation", async () => {
    expect(await openTargetTag(key, true, 2)).toBe(9885216746269472129n);
    expect(await joinTargetTag(key)).toBe(14060664597131761704n);
  });
  it("differ by terms and by kind", async () => {
    const tags = new Set([await openTargetTag(key, false, 0), await openTargetTag(key, true, 0), await openTargetTag(key, false, 1), await joinTargetTag(key)]);
    expect(tags.size).toBe(4);
  });
  it("leave the seat key alone 15 minutes after open_ticket, minus a margin to land", () => {
    const opened = 1_000_000;
    const expires = opened + 3600;
    expect(inSeatWindow(expires, opened + 60)).toBe(true);
    expect(inSeatWindow(expires, opened + 900 - 61)).toBe(true);
    expect(inSeatWindow(expires, opened + 900 - 60)).toBe(false);
  });
  it("leave the wallet signing for a Ticket bound to nothing (one opened before the upgrade reads 0), another Match, or a Backing Ticket", async () => {
    const tag = await joinTargetTag(key);
    const now = 1_000_000;
    const t = { kind: "entry" as const, targetTag: tag, expiresAt: now + 3600 - 60 };
    expect(seatSpends(t, tag, now)).toBe(true);
    expect(seatSpends({ ...t, targetTag: 0n }, 0n, now)).toBe(false);
    expect(seatSpends(t, tag + 1n, now)).toBe(false);
    expect(seatSpends({ ...t, kind: "backing" }, tag, now)).toBe(false);
  });
});
