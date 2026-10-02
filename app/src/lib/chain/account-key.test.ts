import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import { accountKeyOf, parseAccountKey } from "./account-key";

describe("parseAccountKey", () => {
  const wallet = Keypair.generate().publicKey;
  const account = BlockPuzzleChain.coreAccount(wallet);

  it("takes an Account key as it is", () => {
    const parsed = parseAccountKey(account.toBase58());
    expect(parsed?.fromWallet).toBe(false);
    expect(parsed?.key.equals(account)).toBe(true);
  });

  it("sends a wallet address on to the Account it owns", () => {
    const parsed = parseAccountKey(wallet.toBase58());
    expect(parsed?.fromWallet).toBe(true);
    expect(parsed?.key.equals(account)).toBe(true);
    expect(accountKeyOf(wallet.toBase58())).toBe(account.toBase58());
  });

  it("rejects anything that is not a key", () => {
    for (const s of ["", "abc", "not-a-key!", "0".repeat(44), `${PublicKey.default.toBase58()}x`.repeat(2)]) expect(parseAccountKey(s)).toBeNull();
  });
});
