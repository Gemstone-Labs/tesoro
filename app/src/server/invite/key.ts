import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

/** The compromised key (see ../keys.ts): never sign with it. */
const COMPROMISED = "AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV";

/** A secret key from env var `name` (INVITE_SECRET_KEY by default): base58 (64-byte secret) or the keypair file's JSON array. Errors never quote the value. */
export function inviteKeypair(raw: string | undefined, name = "INVITE_SECRET_KEY"): Keypair {
  const value = raw?.trim();
  if (!value) throw new Error(`${name} is not set`);
  let bytes: Uint8Array;
  try {
    bytes = value.startsWith("[") ? Uint8Array.from(JSON.parse(value)) : bs58.decode(value);
  } catch {
    throw new Error(`${name} is neither base58 nor a JSON array of bytes`);
  }
  let kp: Keypair;
  try {
    kp = Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error(`${name} is not a 64-byte Solana secret key`);
  }
  if (kp.publicKey.toBase58() === COMPROMISED) throw new Error(`${name} is the compromised key; refusing to sign with it`);
  return kp;
}
