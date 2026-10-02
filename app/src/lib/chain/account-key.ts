import { PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";

/**
 * The Account a `/account/<key>` address names. An Account key is a program address and so never
 * on the curve; a wallet address is, and maps to the Account it owns. Null when `s` is not a key.
 */
export function parseAccountKey(s: string): { key: PublicKey; fromWallet: boolean } | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return null;
  let key: PublicKey;
  try {
    key = new PublicKey(s);
  } catch {
    return null;
  }
  return PublicKey.isOnCurve(key.toBytes()) ? { key: BlockPuzzleChain.coreAccount(key), fromWallet: true } : { key, fromWallet: false };
}

/** The Account key of a wallet address. */
export const accountKeyOf = (wallet: string) => BlockPuzzleChain.coreAccount(new PublicKey(wallet)).toBase58();
