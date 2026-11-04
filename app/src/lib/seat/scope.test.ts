import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { accountOfSigner, BlockPuzzleChain, isSeatKey, walletOf, type ChainSigner } from "@/games/block-puzzle/chain";
import { SeatKeyManager, memorySeatKeyStore } from "./seat-key";
import { SeatScopeError } from "./seat-scope-error";
import { signAsWallet } from "./wallet-only";
import { pickMatchSigner } from "./useMatchSigner";
import { counted, recordWalletSignature, resetWalletSignatures, walletSignatures, countingFor } from "./signature-counter";

const walletKp = Keypair.generate();
const matchKey = `${Keypair.generate().publicKey.toBase58()}-5`;
const seatOf = () => new SeatKeyManager({ store: memorySeatKeyStore() }).forMatch(matchKey, walletKp.publicKey);
const wallet = (): ChainSigner => ({ publicKey: walletKp.publicKey, signTransaction: async (t) => t, signMessage: async () => new Uint8Array(64) });

describe("identity: Account, wallet and signer are three things", () => {
  it("derives the Account from the wallet behind a seat key, never from the key itself", async () => {
    const seat = await seatOf();
    expect(walletOf(seat).equals(walletKp.publicKey)).toBe(true);
    expect(accountOfSigner(seat).equals(BlockPuzzleChain.coreAccount(walletKp.publicKey))).toBe(true);
    expect(accountOfSigner(seat).equals(BlockPuzzleChain.coreAccount(seat.publicKey))).toBe(false);
    expect(accountOfSigner(wallet()).equals(BlockPuzzleChain.coreAccount(walletKp.publicKey))).toBe(true);
    expect(isSeatKey(seat)).toBe(true);
    expect(isSeatKey(wallet())).toBe(false);
  });
});

describe("a Match page's signer", () => {
  it("is the seat key when this device holds it, with the wallet behind it", async () => {
    const seat = await seatOf();
    const w = wallet();
    const s = pickMatchSigner(w, matchKey, true, seat)!;
    expect(s.publicKey.equals(seat.publicKey)).toBe(true);
    expect(s.fallbackPayer).toBe(w);
  });
  it("is the wallet from a second device (no key here), and nothing while the lookup is pending", () => {
    const w = wallet();
    expect(pickMatchSigner(w, matchKey, true, null)).toBe(w);
    expect(pickMatchSigner(w, matchKey, false, null)).toBeNull();
    expect(pickMatchSigner(null, matchKey, true, null)).toBeNull();
    expect(pickMatchSigner(w, null, false, null)).toBe(w);
  });
});

describe("wallet-only actions refuse a seat key", () => {
  it("every wallet-only request is signed through signAsWallet, which refuses a seat key", async () => {
    const seat = await seatOf();
    await expect(signAsWallet(seat, "tesoro-age|status")).rejects.toBeInstanceOf(SeatScopeError);
    const signMessage = vi.fn(async () => new Uint8Array(64));
    await signAsWallet({ ...wallet(), signMessage }, "tesoro-age|status");
    expect(signMessage).toHaveBeenCalledOnce();
  });

  it("a base-layer send by a seat key is refused before anything is signed", async () => {
    const seat = await seatOf();
    const chain = Object.create(BlockPuzzleChain.prototype) as BlockPuzzleChain;
    await expect(chain.sendBase(seat, [])).rejects.toThrow("This needs your wallet.");
  });

  const root = join(__dirname, "..", "..");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.(ts|tsx)$/.test(f) && !/\.(test|stories)\./.test(f) ? [join(dir, f)] : []));
  const users = (pattern: RegExp) => files(root).filter((f) => pattern.test(readFileSync(f, "utf8"))).map((f) => relative(root, f)).sort();

  it("only the entry, Match and presence code ever looks up or makes a seat key", () => {
    expect(users(/seatKeys\(\)|useMatchSigner\(/)).toEqual([
      "components/match/MatchView.tsx",
      "games/holdem/HoldemMatchView.tsx",
      "games/trading-duel/TradingDuelMatchView.tsx",
      "games/vanguard/VanguardMatchView.tsx",
      "lib/chain/entry-flow.ts",
      "lib/chain/finish-match-client.ts", // deletes the key when the Match closes
      "lib/chain/match-flow.ts", // refund of a Match the key entered
      "lib/chain/usePresence.ts",
      "lib/seat/prune.ts",
      "lib/seat/seat-key.ts",
      "lib/seat/useMatchSigner.ts",
    ]);
  });

  it("the wallet-only clients never see a signer other than the wallet's: they all sign through signAsWallet", () => {
    const direct = users(/signer\.signMessage\(new TextEncoder\(\)\.encode\(signedMessage\(/);
    expect(direct).toEqual(["lib/chain/presence.ts", "lib/chain/sponsor-client.ts"]);
  });
});

describe("dev counter of wallet signatures", () => {
  it("counts each wallet signature against the Match being entered or played, and nothing else", async () => {
    resetWalletSignatures();
    const w = counted({ ...wallet(), signSerialized: async (b: Uint8Array) => b });
    countingFor(matchKey);
    await w.signSerialized!(new Uint8Array());
    await w.signMessage(new Uint8Array());
    await w.signTransaction({} as never);
    recordWalletSignature("message", "other-match");
    expect(walletSignatures()).toEqual({ [matchKey]: { message: 1, transaction: 2, total: 3 }, "other-match": { message: 1, transaction: 0, total: 1 } });
    // a seat key is not the wallet: nothing it signs is counted
    const seat = await seatOf();
    await seat.signMessage(new Uint8Array());
    expect(walletSignatures()[matchKey].total).toBe(3);
    resetWalletSignatures();
  });
});
