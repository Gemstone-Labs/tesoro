import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { NATIVE_MARKET, nativePosition } from "../../../stories/components/wallet/support";
import type { ChainHolding, ChainPosition } from "@/lib/chain/read";
import { depositProgress, fmtBackAt, fmtTimeLeft, likelyPack, monthMs, vaultView, type VaultSnapshot } from "./vault";

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

const holding = (n: number, over: Partial<ChainHolding> = {}): ChainHolding => ({
  holding: key(n),
  source: key(n + 50),
  position: key(n + 100),
  isOwn: false,
  amount: 1000n,
  reserved: 0n,
  free: 1000n,
  redeemable: 400n,
  pending: 600n,
  sourceDebt: 0n,
  unitNum: 10_000_000_000_000n,
  unitDen: 110_000_000n,
  sourceOwner: "Other",
  asset: "SOL",
  native: true,
  stakeMint: null,
  eth: null,
  ...over,
});

const snap = (positions: ChainPosition[], holdings: ChainHolding[] = []): VaultSnapshot => ({ positions, holdings, market: NATIVE_MARKET });
const view = (s: VaultSnapshot | null, gemasAvailable = 0) => vaultView({ snapshot: s, gemasAvailable, nowMs: Date.now() });

/** A Lock whose yield is too small to ever pay back the Gemas given, opened `hoursAgo` hours ago. */
const slow = (hoursAgo: number): ChainPosition => {
  const p = nativePosition("debt");
  return { ...p, native: { ...p.native!, rateBps: 1, openedAt: Math.floor(Date.now() / 1000) - hoursAgo * 3600 } };
};

describe("Vault view model", () => {
  it("is new when there is nothing yet", () => {
    expect(view(snap([]), 0).isNew).toBe(true);
    expect(view(null).isNew).toBe(true);
    expect(view(snap([]), 120).isNew).toBe(false);
  });

  it("numbers deposits in the order they were read and prices them at today's SOL", () => {
    const v = view(snap([nativePosition("debt"), nativePosition("repaid")]));
    expect(v.deposits.map((d) => d.label)).toEqual(["Deposit 1", "Deposit 2"]);
    expect(v.deposits[0].sol).toBe(40);
    expect(v.deposits[0].worthUsd).toBeCloseTo(4400);
  });

  it("calls a deposit growing while it is inside its 12 months and not paid back", () => {
    const d = view(snap([nativePosition("debt")])).deposits[0];
    expect(d.state).toBe("growing");
    expect(d.backAtMs).not.toBeNull();
  });

  it("calls a paid-back deposit ready to withdraw", () => {
    const d = view(snap([nativePosition("repaid")])).deposits[0];
    expect(d.state).toBe("ready");
    expect(d.backAtMs).toBeNull();
  });

  it("calls a deposit late once its 12 months passed and it is still not ready", () => {
    // 12 months are 2 hours in test mode.
    expect(view(snap([slow(1)])).deposits[0].state).toBe("growing");
    expect(view(snap([slow(3)])).deposits[0].state).toBe("late");
  });

  it("counts withdrawn deposits apart and keeps numbering stable", () => {
    const v = view(snap([nativePosition("unlocked"), nativePosition("repaid")]));
    expect(v.withdrawn).toBe(1);
    expect(v.deposits.map((d) => d.label)).toEqual(["Deposit 2"]);
  });

  it("points ETH and HYPE deposits to the Advanced view", () => {
    const eth: ChainPosition = { ...nativePosition("debt"), native: null, asset: "ETH", eth: { vault: "0xabc", id: 1n } };
    const wonEth = holding(7, { native: false, asset: "ETH", eth: { vault: "0xabc", id: 1n } });
    const v = view(snap([eth], [wonEth]));
    expect(v.otherChainDeposits).toBe(true);
    expect(v.deposits).toEqual([]);
  });

  it("says the month in mainnet words and the time in test mode", () => {
    expect(fmtBackAt(Date.UTC(2027, 9, 21, 12, 30))).toMatch(/Oct/);
  });

  it("keeps when each deposit was made", () => {
    const p = nativePosition("debt");
    expect(view(snap([p])).deposits[0].openedAtMs).toBe(p.native!.openedAt * 1000);
  });
});

describe("Deposit card helpers", () => {
  const MIN = 60_000;
  const now = 1_000_000 * MIN;

  it("fills the bar from the day it was made to the day it comes back", () => {
    expect(depositProgress({ state: "growing", openedAtMs: now - 30 * MIN, backAtMs: now + 90 * MIN }, now)).toBeCloseTo(0.25);
    expect(depositProgress({ state: "growing", openedAtMs: now, backAtMs: now + 90 * MIN }, now - MIN)).toBe(0);
    expect(depositProgress({ state: "growing", openedAtMs: now - 200 * MIN, backAtMs: now - MIN }, now)).toBe(1);
  });

  it("measures against the 12 months when there is no date yet", () => {
    expect(depositProgress({ state: "growing", openedAtMs: now - 6 * monthMs(), backAtMs: null }, now)).toBeCloseTo(0.5);
  });

  it("shows a full bar once ready or late", () => {
    expect(depositProgress({ state: "ready", openedAtMs: now, backAtMs: null }, now)).toBe(1);
    expect(depositProgress({ state: "late", openedAtMs: now, backAtMs: now + MIN }, now)).toBe(1);
  });

  it("says the time left in the biggest unit that reads well", () => {
    expect(fmtTimeLeft(47 * MIN + 12_000)).toBe("47m 12s");
    expect(fmtTimeLeft(42_000)).toBe("42s");
    expect(fmtTimeLeft(3 * 60 * MIN + 5 * MIN)).toBe("3h 05m");
    expect(fmtTimeLeft(12 * 1440 * MIN)).toBe("12 days");
    expect(fmtTimeLeft(1440 * MIN + 3 * 60 * MIN)).toBe("27h 00m");
    expect(fmtTimeLeft(122 * 1440 * MIN)).toBe("4 months");
    expect(fmtTimeLeft(-5)).toBe("0s");
  });

  it("draws the pack whose price is nearest the deposit's value", () => {
    expect(likelyPack(251)).toBe("player");
    expect(likelyPack(98)).toBe("starter");
    expect(likelyPack(530)).toBe("pro");
    expect(likelyPack(null)).toBe("player");
  });
});
