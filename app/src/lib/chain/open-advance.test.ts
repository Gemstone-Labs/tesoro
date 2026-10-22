import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const flow = vi.hoisted(() => ({ openPositionWithAdvance: vi.fn(async () => ({ signature: "sig-native", position: "pos" })), openStakePositionWithAdvance: vi.fn(async () => ({ signature: "sig-stake", position: "pos" })) }));
vi.mock("./native-flow", () => flow);

import { openAndAdvance } from "./open-advance";

const signer = { publicKey: Keypair.generate().publicKey } as never;
const getToken = async () => null;

describe("openAndAdvance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens a simSOL Position and takes the Advance in one go", async () => {
    const steps: string[] = [];
    const r = await openAndAdvance(signer, getToken, { from: "simsol", baseUnits: 2_000_000_000n }, 12, (s) => steps.push(s));
    expect(r).toEqual({ signature: "sig-native", position: "pos" });
    expect(flow.openPositionWithAdvance).toHaveBeenCalledWith(signer, getToken, 2_000_000_000n, 12, expect.any(Function));
    expect(flow.openStakePositionWithAdvance).not.toHaveBeenCalled();
  });

  it("routes a staking-token deposit, or plain SOL to stake, to the stake flow with the token", async () => {
    await openAndAdvance(signer, getToken, { from: "sol", lamports: 5n }, 6);
    expect(flow.openStakePositionWithAdvance).toHaveBeenCalledWith(signer, getToken, { from: "sol", lamports: 5n }, 6, undefined, expect.any(Function));
    expect(flow.openPositionWithAdvance).not.toHaveBeenCalled();
  });
});
