import { BN, BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { describe, expect, it } from "vitest";
import coreIdl from "./idl/tesoro_core.json";
import fixtures from "./position-size.fixtures.json";
import { LEGACY_POSITION_SPACE, POSITION_SPACE, decodePosition, isCurrentPosition, positionBytes, stakeRateHighOf } from "./position-size";

const coder = new BorshAccountsCoder(coreIdl as Idl);
const decode = (d: Buffer) => coder.decode("PositionState", d);
const HIGH = 1_320_000_000_000n;
const devnet = (k: "some" | "noneStale") => Buffer.from(fixtures[k].data, "base64");

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
    // The same fields as reading only its serialised prefix.
    expect(positionBytes(d).subarray(0, 231)).toEqual(d.subarray(0, 231));
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
});
