import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { ChainMatch } from "@/lib/chain/read";
import type { Assignment, Table } from "./chain";
import { closedWhileSeen } from "./closed-while-seen";

const match = new PublicKey(new Uint8Array(32).fill(7));
const a = { tesoroMatch: match, epoch: 3, generation: 1, index: 0, startDeadline: 1_000 } as unknown as Assignment;
const seen = { status: "active", running: null, seat: 1 } as unknown as ChainMatch;
const base = (ring: object[], epoch = 3) => ({ epoch, ring } as unknown as Table);
const done = { state: 2, epoch: 3, tesoroMatch: match };

describe("a Match page whose account closed before the history row exists", () => {
  it("is settled when base's ring holds the Match's result", () => {
    expect(closedWhileSeen(seen, base([done]), a, 500)).toMatchObject({ status: "settled", running: null, seat: 1 });
  });
  it("is refunded when the table moved past the epoch without running it and the start deadline passed", () => {
    expect(closedWhileSeen(seen, base([], 4), a, 2_000)?.status).toBe("refunded");
  });
  it("says nothing while base does not hold a result, or for a Match not seen active", () => {
    expect(closedWhileSeen(seen, base([]), a, 500)).toBeNull();
    expect(closedWhileSeen(seen, null, a, 500)).toBeNull();
    expect(closedWhileSeen({ ...seen, status: "settled" } as ChainMatch, base([done]), a, 500)).toBeNull();
    expect(closedWhileSeen(null, base([done]), a, 500)).toBeNull();
  });
});
