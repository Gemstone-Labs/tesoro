import { describe, expect, it } from "vitest";
import { DEPOSIT_ACK_VERSION } from "./acknowledgment";
import { readDepositAckCache, writeDepositAckCache } from "./ack-client";

const memory = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const blocked = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("deposit acknowledgment skip (\"Don't show this again\")", () => {
  it("is off until the Player ticked the box, then remembered per Account under the current version", () => {
    const s = memory();
    expect(readDepositAckCache("a", s)).toBe(false);
    writeDepositAckCache("a", s);
    expect(readDepositAckCache("a", s)).toBe(true);
    expect(readDepositAckCache("b", s)).toBe(false);
    expect([...s.m.keys()]).toEqual([`tesoro:deposit-ack:${DEPOSIT_ACK_VERSION}:a`]);
  });
  it("does not carry over from another wording version", () => {
    const s = memory();
    s.setItem("tesoro:deposit-ack:1999-01-01:a", "1");
    expect(readDepositAckCache("a", s)).toBe(false);
  });
  it("never throws when storage is blocked", () => {
    expect(() => writeDepositAckCache("a", blocked)).not.toThrow();
    expect(readDepositAckCache("a", blocked)).toBe(false);
  });
});
