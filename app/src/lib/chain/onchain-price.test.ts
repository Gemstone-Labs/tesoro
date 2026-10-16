import { Keypair, PublicKey, type AccountInfo } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PYTH_FEED_IDS, PYTH_RECEIVER, parsePythPrice, pythFeedAddress, quoteNativeAdvance, solPriceKey, takeNativeAdvanceIx } from "./native";

/** A fully verified `PriceUpdateV2` account image. */
function image(asset: keyof typeof PYTH_FEED_IDS, price: bigint, conf: bigint, publishTime: number, expo = -8): AccountInfo<Buffer> {
  const d = Buffer.alloc(134);
  Buffer.from("22f123639d7ef4cd", "hex").copy(d, 0);
  d[40] = 1;
  Buffer.from(PYTH_FEED_IDS[asset], "hex").copy(d, 41);
  d.writeBigInt64LE(price, 73);
  d.writeBigUInt64LE(conf, 81);
  d.writeInt32LE(expo, 89);
  d.writeBigInt64LE(BigInt(publishTime), 93);
  return { data: d, owner: PYTH_RECEIVER, executable: false, lamports: 1, rentEpoch: 0 };
}

describe("Pyth push feeds", () => {
  it("derives the sponsored shard-0 addresses", () => {
    expect(pythFeedAddress("SOL").toBase58()).toBe("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
    expect(pythFeedAddress("ETH").toBase58()).toBe("42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC");
    expect(pythFeedAddress("HYPE").toBase58()).toBe("6usXZCEM4kf1KHGDTzgQLAWtDMNdzLjfAUYSwGKJm19Y");
  });

  it("converts a price the way the program does: micro-USD, floored", () => {
    expect(parsePythPrice(image("SOL", 10_322_918_088n, 3_356_136n, 1_000), "SOL")).toEqual({ microUsd: 103_229_180n, updatedTs: 1_000 });
    expect(parsePythPrice(image("ETH", 150n, 0n, 7, 0), "ETH")?.microUsd).toBe(150_000_000n);
  });

  it("refuses a wrong owner, feed id, level, length, price or a wide confidence interval", () => {
    const ok = image("SOL", 15_000_000_000n, 1_000_000n, 1_000);
    expect(parsePythPrice(ok, "SOL")).not.toBeNull();
    expect(parsePythPrice({ ...ok, owner: Keypair.generate().publicKey }, "SOL")).toBeNull();
    expect(parsePythPrice(ok, "ETH")).toBeNull();
    const partial = image("SOL", 15_000_000_000n, 0n, 1_000);
    partial.data[40] = 0;
    expect(parsePythPrice(partial, "SOL")).toBeNull();
    expect(parsePythPrice({ ...ok, data: ok.data.subarray(0, 133) }, "SOL")).toBeNull();
    expect(parsePythPrice(image("SOL", 0n, 0n, 1_000), "SOL")).toBeNull();
    // 5% is the limit; 5.1% is refused.
    expect(parsePythPrice(image("SOL", 10_000_000_000n, 500_000_000n, 1_000), "SOL")).not.toBeNull();
    expect(parsePythPrice(image("SOL", 10_000_000_000n, 510_000_000n, 1_000), "SOL")).toBeNull();
    expect(parsePythPrice(null, "SOL")).toBeNull();
  });

  it("sizes an Advance on the feed price like the program (12 SOL, 7%, a month, 80% -> 840 Gemas at $150)", () => {
    const price = parsePythPrice(image("SOL", 15_000_000_000n, 0n, 1_000), "SOL")!;
    expect(quoteNativeAdvance(12_000_000_000n, 700, 1, price.microUsd).gemas).toBe(840n);
  });
});

describe("Advance accounts per cluster", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("test mode prices from the keeper's account", () => {
    const ix = takeNativeAdvanceIx(Keypair.generate().publicKey, Keypair.generate().publicKey, 0, 3);
    expect(ix.keys[4].pubkey.equals(solPriceKey())).toBe(true);
    expect(solPriceKey().equals(pythFeedAddress("SOL"))).toBe(false);
  });

  it("mainnet reads the mapped Pyth SOL/USD feed with the on-chain instruction", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_TESORO_CLUSTER", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_ETHEREUM_RPC", "http://eth.invalid");
    vi.stubEnv("NEXT_PUBLIC_HYPEREVM_RPC", "http://hl.invalid");
    const n = await import("./native");
    const mint = n.SIM_SOL_MINT;
    const owner = Keypair.generate().publicKey;
    const ix = n.takeNativeAdvanceIx(owner, Keypair.generate().publicKey, 0, 12);
    const keys = ix.keys.map((k) => k.pubkey.toBase58());
    expect(keys[2]).toBe(n.protectionsPda(n.accountPda(owner)).toBase58());
    expect(keys[4]).toBe(n.onchainPricePda(mint).toBase58());
    expect(keys[5]).toBe(n.pythFeedAddress("SOL").toBase58());
    expect(ix.data.subarray(0, 8).toString("hex")).toBe("2af855d76194c9ac");
    expect(keys).not.toContain(PublicKey.findProgramAddressSync([Buffer.from("price"), mint.toBuffer()], n.TESORO_CORE_ID)[0].toBase58());
    expect(n.solPriceKey().toBase58()).toBe(n.pythFeedAddress("SOL").toBase58());
    expect(n.MAX_PRICE_AGE_SECS).toBe(120);
  });
});
