import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_MARKET } from "../../../stories/components/wallet/support";
import { PRICE_MOVED } from "@/lib/errors";
import type { CheckoutContext } from "./checkout";

/** Stands in for the open-and-advance flows: replays `script`, one outcome per call (a plain function, so a thrown error is only seen by the caller). */
const calls: unknown[][] = [];
let script: (Error | "ok")[] = [];
const open = async (...a: unknown[]) => {
  calls.push(a);
  const next = script[Math.min(calls.length, script.length) - 1];
  if (next instanceof Error) throw next;
  return { position: "P", signature: "S" };
};
vi.mock("@/lib/chain/client", () => ({ getChain: () => ({ base: {} }) }));
vi.mock("@/lib/chain/native", async (orig) => ({ ...(await orig<typeof import("@/lib/chain/native")>()), fetchNativeMarket: async () => NATIVE_MARKET }));
vi.mock("@/lib/chain/native-flow", () => ({
  openPositionWithAdvance: (...a: unknown[]) => open(...a),
  openStakePositionWithAdvance: (...a: unknown[]) => open(...a),
}));

import { PACK_RETRIES, openPackLock } from "./open-pack-lock";

const ctx = { signer: { publicKey: Keypair.generate().publicKey }, getToken: async () => "t", market: NATIVE_MARKET } as unknown as CheckoutContext;
const moved = () => new Error("custom program error: 0x179d");

describe("openPackLock", () => {
  beforeEach(() => {
    calls.length = 0;
    script = [];
  });

  it("sends the Advance with the pack's Gemas as its floor", async () => {
    script = ["ok"];
    const fund = vi.fn(async () => undefined);
    const r = await openPackLock(ctx, { gemas: 700, fund });
    expect(r).toEqual({ positionPubkey: "P", gemas: 700, signatures: ["S"] });
    expect(calls[0][4]).toBe(700n);
    expect(fund).toHaveBeenCalledTimes(1);
  });

  it("re-sizes and sends again when the price moved, at most twice", async () => {
    script = [moved(), moved(), "ok"];
    const fund = vi.fn(async () => undefined);
    await openPackLock(ctx, { gemas: 700, fund });
    expect(calls).toHaveLength(PACK_RETRIES + 1);
    expect(fund).toHaveBeenCalledTimes(PACK_RETRIES + 1);
  });

  it("gives up after the retries and says the price moved", async () => {
    script = [moved()];
    const err = await openPackLock(ctx, { gemas: 700, fund: async () => undefined }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/0x179d/);
    expect(calls).toHaveLength(PACK_RETRIES + 1);
    expect(PRICE_MOVED).toMatch(/price moved/);
  });

  it("does not retry any other failure", async () => {
    script = [new Error("blockhash expired")];
    const err = await openPackLock(ctx, { gemas: 700, fund: async () => undefined }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/blockhash/);
    expect(calls).toHaveLength(1);
  });
});
