import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { planTreasuryRedeems, type TreasuryHolding } from "./treasury.ts";

const math = (over: Partial<TreasuryHolding["math"]> = {}) => ({ issued: 1_000n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 100_000n, unitDen: 1n, ...over });
const row = (free: bigint, m = math(), chain: TreasuryHolding["chain"] = "solana"): TreasuryHolding => ({
  holding: Keypair.generate().publicKey,
  source: Keypair.generate().publicKey,
  position: Keypair.generate().publicKey,
  free,
  math: m,
  chain,
  positionId: new Uint8Array(32),
});

describe("treasury redeems", () => {
  it("redeems the Treasury's pro rata share of a Source's repaid Gemas, nothing before yield has landed", () => {
    assert.deepEqual(planTreasuryRedeems([row(400n)], 4, 1n), [], "no yield yet");
    // 500 of 1,000 Gemas repaid by yield; the Treasury holds 400 of the 1,000 outstanding: 200 are redeemable.
    const [r] = planTreasuryRedeems([row(400n, math({ yieldUnits: 50_000_000n }))], 4, 1n);
    assert.equal(r.gemas, 200n);
  });

  it("leaves dust for a later pass, takes the largest first and caps the pass", () => {
    const repaid = math({ yieldUnits: 100_000_000n });
    const rows = [row(50n, repaid), row(900n, repaid), row(300n, repaid, "ethereum"), row(700n, repaid, "hyperEvm")];
    assert.deepEqual(planTreasuryRedeems(rows, 2, 100n).map((r) => r.holding.free), [900n, 700n]);
    assert.deepEqual(planTreasuryRedeems(rows, 4, 100n).map((r) => r.holding.free), [900n, 700n, 300n]);
    assert.deepEqual(planTreasuryRedeems(rows, 4, 1n).map((r) => r.holding.free), [900n, 700n, 300n, 50n]);
  });

  it("plans nothing for an empty Treasury Account", () => {
    assert.deepEqual(planTreasuryRedeems([]), []);
  });
});
