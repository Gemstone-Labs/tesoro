import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { weiToCoreUnits } from "./eth-units";
import { sourcePda } from "./native";
import {
  NETS,
  bridgePeerPda,
  bridgePositionPda,
  BRIDGE_POSITION_LEN,
  claimPda,
  coreAccountPda,
  corePositionPda,
  ethPositionId,
  ethSourceIndex,
  fetchEthState,
  ethUnlockEstimateMs,
  initPositionIdAllowed,
  netOfVault,
  parseBridgePosition,
  parseClaim,
  sourceAuthPda,
  vaultTreasuryPda,
  vaultsOn,
  parseEthPositionId,
  projectedEthDebt,
  quoteEthAdvance,
  simRateAt,
  type EthState,
  type SimRate,
} from "./eth";
import { opCopy, opProgress, opSteps, untrackedOpens, type EthOp } from "./eth-track";

const VAULT = "0x6c836b96464B5D1b55536d5a34D023528eaEe4bD";
const rate: SimRate = { baseRate: 10n ** 18n, baseTime: 1_000n, apyBps: 500n, speedup: 4380n };

describe("position id", () => {
  it("round-trips vault and vault id", () => {
    const pid = ethPositionId(VAULT, 7n);
    expect(pid.length).toBe(32);
    expect(parseEthPositionId(pid)).toEqual({ vault: VAULT.toLowerCase(), id: 7n });
  });
});

describe("advance quote", () => {
  it("is the whole yield (ticket 31): 1 month of 1.0749 ETH at 5% and $3,000 is 1,343 Gemas", () => {
    expect(quoteEthAdvance(1_074_900_000_000_000_000n, 500, 1, 3_000_000_000n).gemas).toBe(1343n);
  });
});

describe("SimLST clock", () => {
  it("keeps the exchange rate constant (yield is minted per Position, docs/yield-model.md)", () => {
    expect(simRateAt(rate)).toBe(rate.baseRate);
    expect(simRateAt(rate)).toBe(rate.baseRate);
  });

  it("estimates a fresh 1-month Advance at 10 minutes, whatever the Principal", () => {
    for (const principal of [10n ** 18n, 4n * 10n ** 18n]) {
      // Advance = principal * 5% / 12 (the whole yield); one Gema = a fixed share of it
      const units = weiToCoreUnits((principal * 500n) / (10_000n * 12n)); // core holds 9-decimal units
      const source = { issued: 1000n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: units, unitDen: 1000n };
      const position = { heldShares: principal, principalUnderlying: principal, paidUnderlying: 0n, accrued: 0n };
      const at = ethUnlockEstimateMs({ source, position, rate, nowMs: 0 })!;
      expect(at / 60_000).toBeGreaterThanOrEqual(9.999); // the unit floor loses under a gwei
      expect(at / 60_000).toBeLessThan(10.01);
    }
  });

  it("is done when the accrued yield already covers the Debt", () => {
    const source = { issued: 1000n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 15n, unitDen: 1n };
    const position = { heldShares: 10n ** 18n, principalUnderlying: 10n ** 18n, paidUnderlying: 0n, accrued: 10n ** 30n };
    expect(ethUnlockEstimateMs({ source, position, rate, nowMs: 5 })).toBe(5);
  });

  it("projects the Debt a report would leave", () => {
    const source = { issued: 1000n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 100n, unitDen: 1n };
    expect(projectedEthDebt(source, 25_000n * 10n ** 9n)).toBe(750n);
    expect(projectedEthDebt(source, 10n ** 21n)).toBe(0n);
  });
});

const G = 10n ** 9n; // wei per core unit: the vault pays wei, Claims count core units
const pos = new PublicKey("11111111111111111111111111111111");
const bridge = (over: Partial<NonNullable<EthState["bridge"]>> = {}): NonNullable<EthState["bridge"]> => ({
  lastInSeq: 0n,
  lockedSeq: 0n,
  ownerEvm: "0x0",
  principal: 0n,
  horizonMonths: 1,
  opened: false,
  lastYieldSeq: 0n,
  yieldCumulative: 0n,
  appliedYieldSeq: 0n,
  outSeq: 0n,
  unlockSent: false,
  treasuryBalance: 0n,
  instantPaid: 0n,
  reportTime: 0n,
  ...over,
});
const core = (advances = 0): NonNullable<EthState["core"]> => ({ position: pos, principalUnits: 1n, rateBps: 500, status: "locked", advances, openAdvance: null, cumulativeYield: 0n });
const st = (over: Partial<EthState>): EthState => ({ bridge: null, core: null, source: null, claim: null, instantClaim: null, holderEvm: null, fetchedAt: 0, ...over });
const op = (kind: EthOp["kind"], extra: Partial<EthOp> = {}): EthOp => ({ key: "k", kind, vault: VAULT, id: "1", createdAt: 0, ...extra });

describe("opProgress: pending never shows success early", () => {
  it("open: waits for delivery, then apply_locked, then the Advance, and only then Gemas", () => {
    expect(opProgress(op("open"), st({}), null)).toEqual({ stage: 1, next: null });
    expect(opProgress(op("open"), st({ bridge: bridge() }), null)).toEqual({ stage: 1, next: null });
    expect(opProgress(op("open"), st({ bridge: bridge({ lastInSeq: 1n }) }), null)).toEqual({ stage: 2, next: "apply-locked" });
    expect(opProgress(op("open"), st({ bridge: bridge({ lastInSeq: 1n }), core: core(0) }), null)).toEqual({ stage: 3, next: "advance" });
    expect(opProgress(op("open"), st({ bridge: bridge({ lastInSeq: 1n }), core: core(1) }), null)).toEqual({ stage: 5, next: null });
  });

  it("yield: done only when the new report was applied", () => {
    const o = op("yield", { baseline: "1" });
    expect(opProgress(o, st({ bridge: bridge({ lastYieldSeq: 1n, appliedYieldSeq: 1n }) }), null).stage).toBe(1);
    expect(opProgress(o, st({ bridge: bridge({ lastYieldSeq: 2n, appliedYieldSeq: 1n }) }), null)).toEqual({ stage: 2, next: "apply-yield" });
    expect(opProgress(o, st({ bridge: bridge({ lastYieldSeq: 2n, appliedYieldSeq: 2n }) }), null).stage).toBe(3);
  });

  describe("redeem", () => {
    const o = op("redeem", { sourceIndex: 0, baseline: "500", units: "500", fromBlock: "10" });
    const claim = (sent: bigint) => ({ gemasTotal: 1n, unitsTotal: 500n, unitsSent: sent });

    it("the send, then the payout to this holder on Hoodi", () => {
      expect(opProgress(o, st({ claim: claim(0n) }), null, 0n)).toEqual({ stage: 1, next: "send-pay-yield" });
      expect(opProgress(o, st({ claim: claim(500n) }), null, 0n)).toEqual({ stage: 2, next: null });
      expect(opProgress(o, st({ claim: claim(500n) }), null, null)).toEqual({ stage: 2, next: null });
      expect(opProgress(o, st({ claim: claim(500n) }), null, 500n * G)).toEqual({ stage: 3, next: null });
    });

    it("another holder's payout (Position-wide paidUnderlying) does not mark this holder paid (SP-03)", () => {
      const vp = { paidUnderlying: 500n, unlocked: false } as never;
      expect(opProgress(o, st({ claim: claim(0n) }), vp, 0n)).toEqual({ stage: 1, next: "send-pay-yield" });
    });

    it("a message in flight (sent, nothing paid to this holder yet) is not paid (SP-03)", () => {
      const vp = { paidUnderlying: 500n, unlocked: false } as never;
      expect(opProgress(o, st({ claim: claim(500n) }), vp, 0n).stage).toBe(2);
    });

    it("a partial payout is not paid; the Claim for an op's own units decides sent", () => {
      expect(opProgress(o, st({ claim: claim(500n) }), null, 499n * G).stage).toBe(2);
      const second = op("redeem", { sourceIndex: 0, baseline: "800", units: "300", fromBlock: "10" });
      expect(opProgress(second, st({ claim: { gemasTotal: 1n, unitsTotal: 800n, unitsSent: 500n } }), null, 300n * G)).toEqual({ stage: 1, next: "send-pay-yield" });
    });
  });

  it("instant: tracked against the Instant Claim and paid by InstantPaid", () => {
    const o = op("instant", { sourceIndex: 0, baseline: "650", units: "650", fromBlock: "1" });
    const instantClaim = (sent: bigint) => ({ gemasTotal: 1n, unitsTotal: 650n, unitsSent: sent });
    expect(opProgress(o, st({ claim: instantClaim(650n) }), null, 650n)).toEqual({ stage: 1, next: "send-pay-instant" });
    expect(opProgress(o, st({ instantClaim: instantClaim(0n) }), null, 0n)).toEqual({ stage: 1, next: "send-pay-instant" });
    expect(opProgress(o, st({ instantClaim: instantClaim(650n) }), null, 0n)).toEqual({ stage: 2, next: null });
    expect(opProgress(o, st({ instantClaim: instantClaim(650n) }), null, 650n * G)).toEqual({ stage: 3, next: null });
  });

  it("unlock: send, then Principal on Hoodi", () => {
    const o = op("unlock");
    expect(opProgress(o, st({ bridge: bridge() }), { unlocked: false } as never)).toEqual({ stage: 1, next: "send-unlock" });
    expect(opProgress(o, st({ bridge: bridge({ unlockSent: true }) }), { unlocked: false } as never).stage).toBe(2);
    expect(opProgress(o, st({ bridge: bridge({ unlockSent: true }) }), { unlocked: true } as never).stage).toBe(3);
  });
});

describe("fetchEthState reads the Claim of the redeemed Source (SP-02)", () => {
  const holder = new PublicKey("11111111111111111111111111111112");
  const corePk = corePositionPda(ethPositionId(VAULT, 1n));
  const corePosition = (advances: number) => {
    const d = Buffer.alloc(8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1 + 4 + 1 + 8 + 8 + 16);
    d.writeUInt32LE(advances, 8 + 1 + 32 + 32 + 1 + 32 + 1 + 8 + 2 + 1);
    return d;
  };
  const claimData = (total: bigint, sent: bigint) => {
    const d = Buffer.alloc(136);
    d.writeBigUInt64LE(total, 112);
    d.writeBigUInt64LE(sent, 120);
    return d;
  };
  const connection = (accounts: Map<string, Buffer>, requested: string[] = []) =>
    ({
      getMultipleAccountsInfo: async (keys: PublicKey[]) =>
        keys.map((k) => {
          requested.push(k.toBase58());
          const data = accounts.get(k.toBase58());
          return data ? { data, owner: PublicKey.default, lamports: 1, executable: false } : null;
        }),
    }) as never;
  const claim0 = claimPda(coreAccountPda(holder), sourcePda(corePk, 0));

  it("with two Advances, Source 0's Claim is read when asked for; the default stays the latest", async () => {
    const accounts = new Map([[corePk.toBase58(), corePosition(2)], [claim0.toBase58(), claimData(500n, 0n)]]);
    const asked = await fetchEthState(connection(accounts), VAULT, 1n, holder, 0);
    expect(asked.claim).toEqual({ gemasTotal: 0n, unitsTotal: 500n, unitsSent: 0n });
    expect((await fetchEthState(connection(accounts), VAULT, 1n, holder)).claim).toBeNull();
  });

  it("a redeem op for Source 0 is not Paid at creation: the Claim is owed and unsent", async () => {
    const accounts = new Map([[corePk.toBase58(), corePosition(2)], [claim0.toBase58(), claimData(500n, 0n)]]);
    const s = await fetchEthState(connection(accounts), VAULT, 1n, holder, 0);
    const o = op("redeem", { sourceIndex: 0, baseline: "500", units: "500", fromBlock: "1" });
    expect(opProgress(o, s, { paidUnderlying: 100n } as never, 0n)).toEqual({ stage: 1, next: "send-pay-yield" });
  });

  it("an index past the Position's Advances reads no Source or Claim", async () => {
    const requested: string[] = [];
    const s = await fetchEthState(connection(new Map([[corePk.toBase58(), corePosition(2)]]), requested), VAULT, 1n, holder, 2);
    expect(s.source).toBeNull();
    expect(s.claim).toBeNull();
    expect(requested).not.toContain(sourcePda(corePk, 2).toBase58());
  });

  it("finds a Source's index among the Advances", () => {
    expect(ethSourceIndex(corePk, sourcePda(corePk, 1), 2)).toBe(1);
    expect(ethSourceIndex(corePk, sourcePda(corePk, 2), 2)).toBeNull();
  });
});

describe("init-position ids (OC-08)", () => {
  it("allows opened Positions and the next three ids only", () => {
    expect(initPositionIdAllowed(1n, 41n)).toBe(true);
    expect(initPositionIdAllowed(41n, 41n)).toBe(true);
    expect(initPositionIdAllowed(44n, 41n)).toBe(true);
    expect(initPositionIdAllowed(45n, 41n)).toBe(false);
    expect(initPositionIdAllowed((1n << 63n) - 1n, 41n)).toBe(false);
    expect(initPositionIdAllowed(0n, 41n)).toBe(false);
    expect(initPositionIdAllowed(1n, 0n)).toBe(true);
  });
});

describe("untrackedOpens", () => {
  const pos = (over: Partial<{ eth: { vault: string; id: bigint } | null; status: string; advances: number }> = {}) => ({
    eth: { vault: VAULT, id: 7n },
    status: "locked",
    advances: 0,
    ...over,
  });
  const open = (over: Partial<EthOp> = {}): EthOp => ({ key: "k", kind: "open", vault: VAULT.toLowerCase(), id: "7", createdAt: 0, months: 1, ...over });

  it("resumes a recorded ETH Position with no Advance and no op in this browser", () => {
    expect(untrackedOpens([pos()], [])).toEqual([{ vault: VAULT, id: 7n }]);
  });

  it("leaves a Position an unfinished open op already tracks", () => {
    expect(untrackedOpens([pos()], [open()])).toEqual([]);
    expect(untrackedOpens([pos()], [open({ done: true })])).toHaveLength(1);
    expect(untrackedOpens([pos()], [open({ id: "8" })])).toHaveLength(1);
  });

  it("skips Positions with an Advance, unlocked or non-ETH Positions", () => {
    expect(untrackedOpens([pos({ advances: 1 }), pos({ status: "unlocked" }), pos({ eth: null })], [])).toEqual([]);
  });
});

describe("HyperEVM vault (smoke Position 1, devnet)", () => {
  const HYPE_VAULT = "0x23B17A4c55867406E7CD5602c664E1447400c4a3";

  it("is listed on its own network and told apart from the Hoodi vault", () => {
    expect(vaultsOn("hyperevm").map((v) => v.symbol)).toEqual(["simHYPE"]);
    expect(vaultsOn("hoodi").map((v) => v.symbol)).toEqual(["simETH"]);
    expect([netOfVault(HYPE_VAULT).eid, netOfVault(HYPE_VAULT).chainByte, netOfVault(HYPE_VAULT).native]).toEqual([40362, 2, "HYPE"]);
    expect([netOfVault(VAULT).eid, netOfVault(VAULT).chainByte]).toEqual([40449, 1]);
    expect(netOfVault("0x000000000000000000000000000000000000dEaD")).toBe(NETS.hoodi);
  });

  it("derives the bridge and tesoro_core accounts the smoke test created on devnet", () => {
    const pid = ethPositionId(HYPE_VAULT, 1n);
    expect(bridgePositionPda(pid).toBase58()).toBe("FykBLi3veGVm7pDLwos6JfQ8wXmvs3j5WMTPYm47MwBx");
    expect(corePositionPda(pid).toBase58()).toBe("BHVeYiAZxNzsFj5PrSSTHaCmFZehyKJtwofqEwZFtNZY");
    expect(bridgePeerPda(HYPE_VAULT).equals(bridgePeerPda(VAULT))).toBe(false);
    expect(sourceAuthPda(NETS.hyperevm).equals(sourceAuthPda(NETS.hoodi))).toBe(false);
  });

  it("words trackers for the vault's own chain", () => {
    expect(opSteps("open", HYPE_VAULT)[0].title).toBe("HyperEVM confirmed");
    expect(opSteps("redeem", HYPE_VAULT)[2].title).toBe("simHYPE on HyperEVM");
    expect(opSteps("open", VAULT)[0].title).toBe("Hoodi confirmed");
    expect(opCopy("open", HYPE_VAULT).label).toBe("HYPE → Gemas");
    expect(opCopy("unlock", HYPE_VAULT).done).toBe("Your coins are back on HyperEVM.");
  });
});

describe("old accounts are absent, not crashes", () => {
  it("reads a BridgePosition only in the 212-byte layout (treasury_balance, instant_paid)", () => {
    const d = Buffer.alloc(BRIDGE_POSITION_LEN);
    d.writeBigUInt64LE(5n, 45);
    d[130] = 1;
    d.writeBigUInt64LE(77n, 172);
    d.writeBigUInt64LE(9n, 188);
    d.writeBigUInt64LE(1_700_000_000n, 204);
    expect(d.length).toBe(212);
    expect(parseBridgePosition(d)).toMatchObject({ lastInSeq: 5n, opened: true, treasuryBalance: 77n, instantPaid: 9n, reportTime: 1_700_000_000n });
    expect(parseBridgePosition(d.subarray(0, 204))).toBeNull();
    expect(parseBridgePosition(d.subarray(0, 172))).toBeNull();
    expect(parseBridgePosition(Buffer.alloc(0))).toBeNull();
  });

  it("reads a Claim only when it is whole", () => {
    const d = Buffer.alloc(136);
    d.writeBigUInt64LE(9n, 112);
    expect(parseClaim(d)).toEqual({ gemasTotal: 0n, unitsTotal: 9n, unitsSent: 0n });
    expect(parseClaim(d.subarray(0, 100))).toBeNull();
  });

  it("derives the bridge's treasury mirror per network and vault", () => {
    const hoodi = vaultTreasuryPda(NETS.hoodi.eid, VAULT);
    expect(vaultTreasuryPda(NETS.hyperevm.eid, VAULT).equals(hoodi)).toBe(false);
    expect(vaultTreasuryPda(NETS.hoodi.eid, VAULT.toLowerCase()).equals(hoodi)).toBe(true);
  });
});
