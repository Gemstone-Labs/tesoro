import { BN, BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import coreIdl from "./idl/tesoro_core.json";
import fixtures from "./position-size.fixtures.json";
import stakeFixtures from "./position-stake.fixtures.json";
import { LEGACY_POSITION_SPACE, POSITION_SPACE, decodePosition, isCurrentPosition, stakeRateHighOf } from "./position-size";

const coder = new BorshAccountsCoder(coreIdl as Idl);
const decode = (d: Buffer) => coder.decode("PositionState", d);
const HIGH = 1_320_000_000_000n;
const devnet = (k: "some" | "noneStale") => Buffer.from(fixtures[k].data, "base64");

type StakeName = Exclude<keyof typeof stakeFixtures, "_note">;
const STAKE = Object.keys(stakeFixtures).filter((k) => k !== "_note") as StakeName[];
/** A stake Position image written by tesoro_core in LiteSVM, and the program's own decode of it. */
const stake = (k: StakeName) => ({ data: Buffer.from(stakeFixtures[k].data, "hex"), expect: stakeFixtures[k].expect });
const str = (v: { toString(): string } | null) => (v === null ? null : v.toString());
/** The decoded fields the program's decode lists (u64/u128 as strings). */
const fieldsOf = (p: any) => ({
  owner: new PublicKey(p.inner.owner).toBase58(),
  sourceAsset: new PublicKey(p.inner.source_asset).toBase58(),
  openedAt: str(p.inner.opened_at),
  bytes: 0,
  openAdvance: p.inner.open_advance,
  decimals: p.inner.decimals,
  principal: str(p.inner.principal),
  rateBps: p.inner.rate_bps,
  advances: p.inner.advances,
  lastSeq: str(p.inner.last_seq),
  cumulativeYield: str(p.inner.cumulative_yield),
  freeYield: str(p.inner.free_yield),
  freeYieldClaimed: str(p.inner.free_yield_claimed),
  appliedNet: str(p.inner.applied_net),
  custodyShares: str(p.inner.custody_shares),
  yieldFeeBps: p.inner.yield_fee_bps,
  stakeRateOpen: str(p.inner.stake_rate_open),
  heldShares: str(p.inner.held_shares),
  freeShares: str(p.inner.free_shares),
  paidShares: str(p.inner.paid_shares),
  poolBps: p.inner.pool_bps,
  stakeRateHigh: str(p.inner.stake_rate_high),
});
/** The coder's decode of the raw bytes, without the helper (null when it throws). */
const rawDecode = (d: Buffer) => {
  try {
    return decode(d);
  } catch {
    return null;
  }
};

/** A current (243-byte) Position as the program writes it, from a decoded one with `stakeRateHigh` set. */
async function current(from: Buffer, high: bigint): Promise<Buffer> {
  const p = decodePosition(decode, from);
  p.inner.stake_rate_high = new BN(high.toString());
  const out = Buffer.alloc(POSITION_SPACE, 0xcd);
  (await coder.encode("PositionState", p)).copy(out);
  return out;
}

describe("Position sizes", () => {
  it("POSITION_SPACE is the byte length of a PositionState in the IDL; the 235-byte layout is the one before ticket 55", () => {
    expect(coder.size("PositionState" as never)).toBe(POSITION_SPACE);
    expect([POSITION_SPACE, LEGACY_POSITION_SPACE]).toEqual([243, 235]);
  });

  it("lists both layouts and nothing older (a pre-upgrade Position is 159 bytes)", () => {
    expect(isCurrentPosition(Buffer.alloc(POSITION_SPACE))).toBe(true);
    expect(isCurrentPosition(Buffer.alloc(LEGACY_POSITION_SPACE))).toBe(true);
    expect(isCurrentPosition(Buffer.alloc(159))).toBe(false);
  });
});

describe("decodePosition", () => {
  it("reads a real 235-byte devnet Position with an open Advance (tag 1 at byte 122)", () => {
    const d = devnet("some");
    expect([d.length, d[122]]).toEqual([235, 1]);
    const p = decodePosition(decode, d);
    expect(p.inner.open_advance).not.toBeNull();
    expect(BigInt(p.inner.stake_rate_high.toString())).toBe(0n);
    expect(stakeRateHighOf(d)).toBe(0n);
  });

  it("reads a real 235-byte devnet Position whose open Advance closed, ignoring the stale bytes after it", () => {
    const d = devnet("noneStale");
    expect([d.length, d[122]]).toEqual([235, 0]);
    expect(d.subarray(231).some((b) => b !== 0)).toBe(true);
    const p = decodePosition(decode, d);
    expect(p.inner.open_advance).toBeNull();
    expect(BigInt(p.inner.stake_rate_high.toString())).toBe(0n);
    // Field values are checked against the program's own decode for the stake images below, and against the raw-offset
    // reader (nativeInfoFrom) for these devnet ones in native.test.ts.
  });

  it("reads every stake Position the program writes as the program does (235 and 243 bytes, Some and None)", () => {
    expect(STAKE.map((k) => [stake(k).data.length, stake(k).expect.openAdvance])).toEqual([
      [243, 0],
      [243, null],
      [235, 0],
      [235, null],
    ]);
    for (const k of STAKE) {
      const { data, expect: want } = stake(k);
      // A 235-byte Position has no stake_rate_high yet: the helper reads it as 0.
      expect({ ...fieldsOf(decodePosition(decode, data)), bytes: data.length }, k).toEqual({ ...want, stakeRateHigh: want.stakeRateHigh ?? "0" });
      expect(stakeRateHighOf(data), k).toBe(BigInt(want.stakeRateHigh ?? 0));
    }
    expect(stake("stake243Some").expect.stakeRateHigh).not.toBe(stake("stake243Some").expect.stakeRateOpen);
  });

  it("misreads a 235-byte Position whose Advance closed when decoded without the helper (why every read goes through positionBytes)", () => {
    // The coder does not throw on a short account: it reads past the end as zeros. That happens to give a 235-byte Some its
    // right fields, but a None keeps the old Some's tail, and those stale bytes become stake_rate_high, a rate never priced.
    for (const d of [devnet("noneStale"), stake("stake235NoneStale").data]) {
      const raw = rawDecode(d)!;
      expect(str(raw.inner.stake_rate_high)).not.toBe("0");
      expect(fieldsOf(raw)).not.toEqual(fieldsOf(decodePosition(decode, d)));
    }
  });

  it("reads stake_rate_high of a 243-byte Position at both tags, stale bytes and all", async () => {
    for (const k of ["some", "noneStale"] as const) {
      const d = await current(devnet(k), HIGH);
      expect(d.length).toBe(243);
      const end = d[122] === 1 ? 243 : 239;
      expect(d.readBigUInt64LE(end - 8)).toBe(HIGH);
      expect(stakeRateHighOf(d)).toBe(HIGH);
      expect(BigInt(decodePosition(decode, d).inner.stake_rate_high.toString())).toBe(HIGH);
      expect(decodePosition(decode, d).inner.principal.toString()).toBe(decodePosition(decode, devnet(k)).inner.principal.toString());
    }
  });

  describe("in the browser, whose Buffer has no BigInt readers", () => {
    // Next.js bundles its own `buffer` (v5) for the browser: no readBigUInt64LE, no readBigInt64LE.
    const BrowserBuffer = createRequire(import.meta.url)("next/dist/compiled/buffer").Buffer;
    afterEach(() => vi.unstubAllGlobals());

    it("reads stake_rate_high of a 243-byte Position without them", async () => {
      expect(typeof BrowserBuffer.from([0]).readBigUInt64LE).toBe("undefined");
      for (const k of ["some", "noneStale"] as const) {
        const d = await current(devnet(k), HIGH);
        vi.stubGlobal("Buffer", BrowserBuffer);
        expect(stakeRateHighOf(d)).toBe(HIGH);
        vi.unstubAllGlobals();
      }
    });
  });
});
