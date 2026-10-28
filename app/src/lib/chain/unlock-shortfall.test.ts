import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { Keypair, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { parseUnlockShortfall, previewUnlockShortfall, shortfallLamports, shortfallCopy } from "./unlock-shortfall";
import { unlockStakeIx } from "./stake";
import { JITOSOL } from "./stake";

const POSITION = new PublicKey("11111111111111111111111111111112");

/** A real `UnlockShortfall` log line: discriminator from the IDL, then position and three u64. */
function eventLine(gap: bigint, shortfall = 0n, topped = 0n) {
  const b = Buffer.alloc(8 + 32 + 24);
  Buffer.from([3, 215, 85, 235, 10, 139, 138, 101]).copy(b, 0);
  POSITION.toBuffer().copy(b, 8);
  b.writeBigUInt64LE(shortfall, 40);
  b.writeBigUInt64LE(topped, 48);
  b.writeBigUInt64LE(gap, 56);
  return `Program data: ${b.toString("base64")}`;
}

describe("parseUnlockShortfall", () => {
  it("reads the gap the program computed from the Unlock logs", () => {
    const logs = ["Program log: Instruction: Unlock", eventLine(509_090_908n), "Program X success"];
    expect(parseUnlockShortfall(logs)).toEqual({ position: POSITION, shortfallShares: 0n, toppedUpShares: 0n, gapShares: 509_090_908n });
  });
  it("is null when the Unlock paid in full (no event)", () => {
    expect(parseUnlockShortfall(["Program log: Instruction: Unlock", "Program X success"])).toBeNull();
  });
  it("ignores other events and malformed data", () => {
    expect(parseUnlockShortfall(["Program data: AAAA", "Program data: not base64 !!"])).toBeNull();
  });
  it("counts only what the owner did not get: a Treasury top-up already sits in the owner's payout", () => {
    const got = parseUnlockShortfall([eventLine(0n, 90_909_091n, 90_909_091n)]);
    expect(got?.gapShares).toBe(0n);
  });
});

describe("shortfallLamports", () => {
  it("values the missing shares at today's rate (walk-through: 509,090,908 shares at 1.25)", () => {
    expect(shortfallLamports(509_090_908n, 1_250_000_000_000n)).toBe(636_363_635n);
  });
});

describe("shortfallCopy", () => {
  it("says how much is short and why, in plain words", () => {
    const c = shortfallCopy({ gapLamports: 636_363_635n, principalLamports: 12_000_000_000n, symbol: "jitoSOL" });
    expect(c?.title).toBe("About 0.64 SOL short");
    expect(c?.body).toContain("rate fell after your yield was paid");
    expect(c?.body).toContain("12 SOL");
  });
  it("is null when nothing is missing", () => {
    expect(shortfallCopy({ gapLamports: 0n, principalLamports: 12_000_000_000n, symbol: "jitoSOL" })).toBeNull();
  });
});

describe("the Unlock dry run", () => {
  const player = Keypair.generate().publicKey;
  const relayer = Keypair.generate().publicKey;
  const position = Keypair.generate().publicKey;
  const ixs = [unlockStakeIx(player, position, null, JITOSOL)];

  function conn(value: { err: unknown; logs: string[] }) {
    const seen: { tx?: VersionedTransaction; opts?: unknown } = {};
    const c = { simulateTransaction: async (tx: VersionedTransaction, opts: unknown) => ((seen.tx = tx), (seen.opts = opts), { value }) } as unknown as Connection;
    return { c, seen };
  }

  it("simulates with the given fee payer, no signatures and a replaced blockhash", async () => {
    const { c, seen } = conn({ err: null, logs: [] });
    await previewUnlockShortfall(c, relayer, ixs);
    expect(seen.tx!.message.staticAccountKeys[0].equals(relayer)).toBe(true);
    expect(seen.opts).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true });
  });
  it("reports the shortfall the program logged", async () => {
    const { c } = conn({ err: null, logs: [eventLine(509_090_908n)] });
    const got = await previewUnlockShortfall(c, relayer, ixs);
    expect(got).toMatchObject({ state: "short", shortfall: { gapShares: 509_090_908n } });
  });
  it("says full when the program logged no shortfall", async () => {
    expect(await previewUnlockShortfall(conn({ err: null, logs: ["Program X success"] }).c, relayer, ixs)).toEqual({ state: "full" });
  });
  it("a failed simulation is unknown, never 'paid in full'", async () => {
    const got = await previewUnlockShortfall(conn({ err: "AccountNotFound", logs: [] }).c, player, ixs);
    expect(got.state).toBe("unknown");
  });
});
